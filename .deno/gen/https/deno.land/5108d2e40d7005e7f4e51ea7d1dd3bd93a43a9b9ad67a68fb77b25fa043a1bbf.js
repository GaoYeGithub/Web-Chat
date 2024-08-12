// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
import { encode } from "../encoding/utf8.ts";
import { BufReader, BufWriter } from "../io/bufio.ts";
import { assert } from "../_util/assert.ts";
import { deferred, MuxAsyncIterator } from "../async/mod.ts";
import { bodyReader, chunkedBodyReader, emptyReader, readRequest, writeResponse } from "./_io.ts";
export class ServerRequest {
    url;
    method;
    proto;
    protoMinor;
    protoMajor;
    headers;
    conn;
    r;
    w;
    done = deferred();
    _contentLength = undefined;
    /**
   * Value of Content-Length header.
   * If null, then content length is invalid or not given (e.g. chunked encoding).
   */ get contentLength() {
        // undefined means not cached.
        // null means invalid or not provided.
        if (this._contentLength === undefined) {
            const cl = this.headers.get("content-length");
            if (cl) {
                this._contentLength = parseInt(cl);
                // Convert NaN to null (as NaN harder to test)
                if (Number.isNaN(this._contentLength)) {
                    this._contentLength = null;
                }
            } else {
                this._contentLength = null;
            }
        }
        return this._contentLength;
    }
    _body = null;
    /**
   * Body of the request.  The easiest way to consume the body is:
   *
   *     const buf: Uint8Array = await Deno.readAll(req.body);
   */ get body() {
        if (!this._body) {
            if (this.contentLength != null) {
                this._body = bodyReader(this.contentLength, this.r);
            } else {
                const transferEncoding = this.headers.get("transfer-encoding");
                if (transferEncoding != null) {
                    const parts = transferEncoding.split(",").map((e)=>e.trim().toLowerCase());
                    assert(parts.includes("chunked"), 'transfer-encoding must include "chunked" if content-length is not set');
                    this._body = chunkedBodyReader(this.headers, this.r);
                } else {
                    // Neither content-length nor transfer-encoding: chunked
                    this._body = emptyReader();
                }
            }
        }
        return this._body;
    }
    async respond(r) {
        let err;
        try {
            // Write our response!
            await writeResponse(this.w, r);
        } catch (e) {
            try {
                // Eagerly close on error.
                this.conn.close();
            } catch  {
            // Pass
            }
            err = e;
        }
        // Signal that this request has been processed and the next pipelined
        // request on the same connection can be accepted.
        this.done.resolve(err);
        if (err) {
            // Error during responding, rethrow.
            throw err;
        }
    }
    finalized = false;
    async finalize() {
        if (this.finalized) return;
        // Consume unread body
        const body = this.body;
        const buf = new Uint8Array(1024);
        while(await body.read(buf) !== null){
        // Pass
        }
        this.finalized = true;
    }
}
export class Server {
    listener;
    closing;
    connections;
    constructor(listener){
        this.listener = listener;
        this.closing = false;
        this.connections = [];
    }
    close() {
        this.closing = true;
        this.listener.close();
        for (const conn of this.connections){
            try {
                conn.close();
            } catch (e) {
                // Connection might have been already closed
                if (!(e instanceof Deno.errors.BadResource)) {
                    throw e;
                }
            }
        }
    }
    // Yields all HTTP requests on a single TCP connection.
    async *iterateHttpRequests(conn) {
        const reader = new BufReader(conn);
        const writer = new BufWriter(conn);
        while(!this.closing){
            let request;
            try {
                request = await readRequest(conn, reader);
            } catch (error) {
                if (error instanceof Deno.errors.InvalidData || error instanceof Deno.errors.UnexpectedEof) {
                    // An error was thrown while parsing request headers.
                    await writeResponse(writer, {
                        status: 400,
                        body: encode(`${error.message}\r\n\r\n`)
                    });
                }
                break;
            }
            if (request === null) {
                break;
            }
            request.w = writer;
            yield request;
            // Wait for the request to be processed before we accept a new request on
            // this connection.
            const responseError = await request.done;
            if (responseError) {
                // Something bad happened during response.
                // (likely other side closed during pipelined req)
                // req.done implies this connection already closed, so we can just return.
                this.untrackConnection(request.conn);
                return;
            }
            // Consume unread body and trailers if receiver didn't consume those data
            await request.finalize();
        }
        this.untrackConnection(conn);
        try {
            conn.close();
        } catch (e) {
        // might have been already closed
        }
    }
    trackConnection(conn) {
        this.connections.push(conn);
    }
    untrackConnection(conn) {
        const index = this.connections.indexOf(conn);
        if (index !== -1) {
            this.connections.splice(index, 1);
        }
    }
    // Accepts a new TCP connection and yields all HTTP requests that arrive on
    // it. When a connection is accepted, it also creates a new iterator of the
    // same kind and adds it to the request multiplexer so that another TCP
    // connection can be accepted.
    async *acceptConnAndIterateHttpRequests(mux) {
        if (this.closing) return;
        // Wait for a new connection.
        let conn;
        try {
            conn = await this.listener.accept();
        } catch (error) {
            if (error instanceof Deno.errors.BadResource || error instanceof Deno.errors.InvalidData || error instanceof Deno.errors.UnexpectedEof) {
                return mux.add(this.acceptConnAndIterateHttpRequests(mux));
            }
            throw error;
        }
        this.trackConnection(conn);
        // Try to accept another connection and add it to the multiplexer.
        mux.add(this.acceptConnAndIterateHttpRequests(mux));
        // Yield the requests that arrive on the just-accepted connection.
        yield* this.iterateHttpRequests(conn);
    }
    [Symbol.asyncIterator]() {
        const mux = new MuxAsyncIterator();
        mux.add(this.acceptConnAndIterateHttpRequests(mux));
        return mux.iterate();
    }
}
/**
 * Parse addr from string
 *
 *     const addr = "::1:8000";
 *     parseAddrFromString(addr);
 *
 * @param addr Address string
 */ export function _parseAddrFromStr(addr) {
    let url;
    try {
        const host = addr.startsWith(":") ? `0.0.0.0${addr}` : addr;
        url = new URL(`http://${host}`);
    } catch  {
        throw new TypeError("Invalid address.");
    }
    if (url.username || url.password || url.pathname != "/" || url.search || url.hash) {
        throw new TypeError("Invalid address.");
    }
    return {
        hostname: url.hostname,
        port: url.port === "" ? 80 : Number(url.port)
    };
}
/**
 * Create a HTTP server
 *
 *     import { serve } from "https://deno.land/std/http/server.ts";
 *     const body = "Hello World\n";
 *     const server = serve({ port: 8000 });
 *     for await (const req of server) {
 *       req.respond({ body });
 *     }
 */ export function serve(addr) {
    if (typeof addr === "string") {
        addr = _parseAddrFromStr(addr);
    }
    const listener = Deno.listen(addr);
    return new Server(listener);
}
/**
 * Start an HTTP server with given options and request handler
 *
 *     const body = "Hello World\n";
 *     const options = { port: 8000 };
 *     listenAndServe(options, (req) => {
 *       req.respond({ body });
 *     });
 *
 * @param options Server configuration
 * @param handler Request handler
 */ export async function listenAndServe(addr, handler) {
    const server = serve(addr);
    for await (const request of server){
        handler(request);
    }
}
/**
 * Create an HTTPS server with given options
 *
 *     const body = "Hello HTTPS";
 *     const options = {
 *       hostname: "localhost",
 *       port: 443,
 *       certFile: "./path/to/localhost.crt",
 *       keyFile: "./path/to/localhost.key",
 *     };
 *     for await (const req of serveTLS(options)) {
 *       req.respond({ body });
 *     }
 *
 * @param options Server configuration
 * @return Async iterable server instance for incoming requests
 */ export function serveTLS(options) {
    const tlsOptions = {
        ...options,
        transport: "tcp"
    };
    const listener = Deno.listenTls(tlsOptions);
    return new Server(listener);
}
/**
 * Start an HTTPS server with given options and request handler
 *
 *     const body = "Hello HTTPS";
 *     const options = {
 *       hostname: "localhost",
 *       port: 443,
 *       certFile: "./path/to/localhost.crt",
 *       keyFile: "./path/to/localhost.key",
 *     };
 *     listenAndServeTLS(options, (req) => {
 *       req.respond({ body });
 *     });
 *
 * @param options Server configuration
 * @param handler Request handler
 */ export async function listenAndServeTLS(options, handler) {
    const server = serveTLS(options);
    for await (const request of server){
        handler(request);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvaHR0cC9zZXJ2ZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyMCB0aGUgRGVubyBhdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLiBNSVQgbGljZW5zZS5cbmltcG9ydCB7IGVuY29kZSB9IGZyb20gXCIuLi9lbmNvZGluZy91dGY4LnRzXCI7XG5pbXBvcnQgeyBCdWZSZWFkZXIsIEJ1ZldyaXRlciB9IGZyb20gXCIuLi9pby9idWZpby50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0IH0gZnJvbSBcIi4uL191dGlsL2Fzc2VydC50c1wiO1xuaW1wb3J0IHsgRGVmZXJyZWQsIGRlZmVycmVkLCBNdXhBc3luY0l0ZXJhdG9yIH0gZnJvbSBcIi4uL2FzeW5jL21vZC50c1wiO1xuaW1wb3J0IHtcbiAgYm9keVJlYWRlcixcbiAgY2h1bmtlZEJvZHlSZWFkZXIsXG4gIGVtcHR5UmVhZGVyLFxuICByZWFkUmVxdWVzdCxcbiAgd3JpdGVSZXNwb25zZSxcbn0gZnJvbSBcIi4vX2lvLnRzXCI7XG5cbmV4cG9ydCBjbGFzcyBTZXJ2ZXJSZXF1ZXN0IHtcbiAgdXJsITogc3RyaW5nO1xuICBtZXRob2QhOiBzdHJpbmc7XG4gIHByb3RvITogc3RyaW5nO1xuICBwcm90b01pbm9yITogbnVtYmVyO1xuICBwcm90b01ham9yITogbnVtYmVyO1xuICBoZWFkZXJzITogSGVhZGVycztcbiAgY29ubiE6IERlbm8uQ29ubjtcbiAgciE6IEJ1ZlJlYWRlcjtcbiAgdyE6IEJ1ZldyaXRlcjtcbiAgZG9uZTogRGVmZXJyZWQ8RXJyb3IgfCB1bmRlZmluZWQ+ID0gZGVmZXJyZWQoKTtcblxuICBwcml2YXRlIF9jb250ZW50TGVuZ3RoOiBudW1iZXIgfCB1bmRlZmluZWQgfCBudWxsID0gdW5kZWZpbmVkO1xuICAvKipcbiAgICogVmFsdWUgb2YgQ29udGVudC1MZW5ndGggaGVhZGVyLlxuICAgKiBJZiBudWxsLCB0aGVuIGNvbnRlbnQgbGVuZ3RoIGlzIGludmFsaWQgb3Igbm90IGdpdmVuIChlLmcuIGNodW5rZWQgZW5jb2RpbmcpLlxuICAgKi9cbiAgZ2V0IGNvbnRlbnRMZW5ndGgoKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgLy8gdW5kZWZpbmVkIG1lYW5zIG5vdCBjYWNoZWQuXG4gICAgLy8gbnVsbCBtZWFucyBpbnZhbGlkIG9yIG5vdCBwcm92aWRlZC5cbiAgICBpZiAodGhpcy5fY29udGVudExlbmd0aCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBjbCA9IHRoaXMuaGVhZGVycy5nZXQoXCJjb250ZW50LWxlbmd0aFwiKTtcbiAgICAgIGlmIChjbCkge1xuICAgICAgICB0aGlzLl9jb250ZW50TGVuZ3RoID0gcGFyc2VJbnQoY2wpO1xuICAgICAgICAvLyBDb252ZXJ0IE5hTiB0byBudWxsIChhcyBOYU4gaGFyZGVyIHRvIHRlc3QpXG4gICAgICAgIGlmIChOdW1iZXIuaXNOYU4odGhpcy5fY29udGVudExlbmd0aCkpIHtcbiAgICAgICAgICB0aGlzLl9jb250ZW50TGVuZ3RoID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5fY29udGVudExlbmd0aCA9IG51bGw7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9jb250ZW50TGVuZ3RoO1xuICB9XG5cbiAgcHJpdmF0ZSBfYm9keTogRGVuby5SZWFkZXIgfCBudWxsID0gbnVsbDtcblxuICAvKipcbiAgICogQm9keSBvZiB0aGUgcmVxdWVzdC4gIFRoZSBlYXNpZXN0IHdheSB0byBjb25zdW1lIHRoZSBib2R5IGlzOlxuICAgKlxuICAgKiAgICAgY29uc3QgYnVmOiBVaW50OEFycmF5ID0gYXdhaXQgRGVuby5yZWFkQWxsKHJlcS5ib2R5KTtcbiAgICovXG4gIGdldCBib2R5KCk6IERlbm8uUmVhZGVyIHtcbiAgICBpZiAoIXRoaXMuX2JvZHkpIHtcbiAgICAgIGlmICh0aGlzLmNvbnRlbnRMZW5ndGggIT0gbnVsbCkge1xuICAgICAgICB0aGlzLl9ib2R5ID0gYm9keVJlYWRlcih0aGlzLmNvbnRlbnRMZW5ndGgsIHRoaXMucik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCB0cmFuc2ZlckVuY29kaW5nID0gdGhpcy5oZWFkZXJzLmdldChcInRyYW5zZmVyLWVuY29kaW5nXCIpO1xuICAgICAgICBpZiAodHJhbnNmZXJFbmNvZGluZyAhPSBudWxsKSB7XG4gICAgICAgICAgY29uc3QgcGFydHMgPSB0cmFuc2ZlckVuY29kaW5nXG4gICAgICAgICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAgICAgICAubWFwKChlKTogc3RyaW5nID0+IGUudHJpbSgpLnRvTG93ZXJDYXNlKCkpO1xuICAgICAgICAgIGFzc2VydChcbiAgICAgICAgICAgIHBhcnRzLmluY2x1ZGVzKFwiY2h1bmtlZFwiKSxcbiAgICAgICAgICAgICd0cmFuc2Zlci1lbmNvZGluZyBtdXN0IGluY2x1ZGUgXCJjaHVua2VkXCIgaWYgY29udGVudC1sZW5ndGggaXMgbm90IHNldCcsXG4gICAgICAgICAgKTtcbiAgICAgICAgICB0aGlzLl9ib2R5ID0gY2h1bmtlZEJvZHlSZWFkZXIodGhpcy5oZWFkZXJzLCB0aGlzLnIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIE5laXRoZXIgY29udGVudC1sZW5ndGggbm9yIHRyYW5zZmVyLWVuY29kaW5nOiBjaHVua2VkXG4gICAgICAgICAgdGhpcy5fYm9keSA9IGVtcHR5UmVhZGVyKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX2JvZHk7XG4gIH1cblxuICBhc3luYyByZXNwb25kKHI6IFJlc3BvbnNlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgbGV0IGVycjogRXJyb3IgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIC8vIFdyaXRlIG91ciByZXNwb25zZSFcbiAgICAgIGF3YWl0IHdyaXRlUmVzcG9uc2UodGhpcy53LCByKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBFYWdlcmx5IGNsb3NlIG9uIGVycm9yLlxuICAgICAgICB0aGlzLmNvbm4uY2xvc2UoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBQYXNzXG4gICAgICB9XG4gICAgICBlcnIgPSBlO1xuICAgIH1cbiAgICAvLyBTaWduYWwgdGhhdCB0aGlzIHJlcXVlc3QgaGFzIGJlZW4gcHJvY2Vzc2VkIGFuZCB0aGUgbmV4dCBwaXBlbGluZWRcbiAgICAvLyByZXF1ZXN0IG9uIHRoZSBzYW1lIGNvbm5lY3Rpb24gY2FuIGJlIGFjY2VwdGVkLlxuICAgIHRoaXMuZG9uZS5yZXNvbHZlKGVycik7XG4gICAgaWYgKGVycikge1xuICAgICAgLy8gRXJyb3IgZHVyaW5nIHJlc3BvbmRpbmcsIHJldGhyb3cuXG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBmaW5hbGl6ZWQgPSBmYWxzZTtcbiAgYXN5bmMgZmluYWxpemUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuZmluYWxpemVkKSByZXR1cm47XG4gICAgLy8gQ29uc3VtZSB1bnJlYWQgYm9keVxuICAgIGNvbnN0IGJvZHkgPSB0aGlzLmJvZHk7XG4gICAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoMTAyNCk7XG4gICAgd2hpbGUgKChhd2FpdCBib2R5LnJlYWQoYnVmKSkgIT09IG51bGwpIHtcbiAgICAgIC8vIFBhc3NcbiAgICB9XG4gICAgdGhpcy5maW5hbGl6ZWQgPSB0cnVlO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBTZXJ2ZXIgaW1wbGVtZW50cyBBc3luY0l0ZXJhYmxlPFNlcnZlclJlcXVlc3Q+IHtcbiAgcHJpdmF0ZSBjbG9zaW5nID0gZmFsc2U7XG4gIHByaXZhdGUgY29ubmVjdGlvbnM6IERlbm8uQ29ubltdID0gW107XG5cbiAgY29uc3RydWN0b3IocHVibGljIGxpc3RlbmVyOiBEZW5vLkxpc3RlbmVyKSB7fVxuXG4gIGNsb3NlKCk6IHZvaWQge1xuICAgIHRoaXMuY2xvc2luZyA9IHRydWU7XG4gICAgdGhpcy5saXN0ZW5lci5jbG9zZSgpO1xuICAgIGZvciAoY29uc3QgY29ubiBvZiB0aGlzLmNvbm5lY3Rpb25zKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25uLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIENvbm5lY3Rpb24gbWlnaHQgaGF2ZSBiZWVuIGFscmVhZHkgY2xvc2VkXG4gICAgICAgIGlmICghKGUgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5CYWRSZXNvdXJjZSkpIHtcbiAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gWWllbGRzIGFsbCBIVFRQIHJlcXVlc3RzIG9uIGEgc2luZ2xlIFRDUCBjb25uZWN0aW9uLlxuICBwcml2YXRlIGFzeW5jICppdGVyYXRlSHR0cFJlcXVlc3RzKFxuICAgIGNvbm46IERlbm8uQ29ubixcbiAgKTogQXN5bmNJdGVyYWJsZUl0ZXJhdG9yPFNlcnZlclJlcXVlc3Q+IHtcbiAgICBjb25zdCByZWFkZXIgPSBuZXcgQnVmUmVhZGVyKGNvbm4pO1xuICAgIGNvbnN0IHdyaXRlciA9IG5ldyBCdWZXcml0ZXIoY29ubik7XG5cbiAgICB3aGlsZSAoIXRoaXMuY2xvc2luZykge1xuICAgICAgbGV0IHJlcXVlc3Q6IFNlcnZlclJlcXVlc3QgfCBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVxdWVzdCA9IGF3YWl0IHJlYWRSZXF1ZXN0KGNvbm4sIHJlYWRlcik7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5JbnZhbGlkRGF0YSB8fFxuICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuVW5leHBlY3RlZEVvZlxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBBbiBlcnJvciB3YXMgdGhyb3duIHdoaWxlIHBhcnNpbmcgcmVxdWVzdCBoZWFkZXJzLlxuICAgICAgICAgIGF3YWl0IHdyaXRlUmVzcG9uc2Uod3JpdGVyLCB7XG4gICAgICAgICAgICBzdGF0dXM6IDQwMCxcbiAgICAgICAgICAgIGJvZHk6IGVuY29kZShgJHtlcnJvci5tZXNzYWdlfVxcclxcblxcclxcbmApLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QgPT09IG51bGwpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIHJlcXVlc3QudyA9IHdyaXRlcjtcbiAgICAgIHlpZWxkIHJlcXVlc3Q7XG5cbiAgICAgIC8vIFdhaXQgZm9yIHRoZSByZXF1ZXN0IHRvIGJlIHByb2Nlc3NlZCBiZWZvcmUgd2UgYWNjZXB0IGEgbmV3IHJlcXVlc3Qgb25cbiAgICAgIC8vIHRoaXMgY29ubmVjdGlvbi5cbiAgICAgIGNvbnN0IHJlc3BvbnNlRXJyb3IgPSBhd2FpdCByZXF1ZXN0LmRvbmU7XG4gICAgICBpZiAocmVzcG9uc2VFcnJvcikge1xuICAgICAgICAvLyBTb21ldGhpbmcgYmFkIGhhcHBlbmVkIGR1cmluZyByZXNwb25zZS5cbiAgICAgICAgLy8gKGxpa2VseSBvdGhlciBzaWRlIGNsb3NlZCBkdXJpbmcgcGlwZWxpbmVkIHJlcSlcbiAgICAgICAgLy8gcmVxLmRvbmUgaW1wbGllcyB0aGlzIGNvbm5lY3Rpb24gYWxyZWFkeSBjbG9zZWQsIHNvIHdlIGNhbiBqdXN0IHJldHVybi5cbiAgICAgICAgdGhpcy51bnRyYWNrQ29ubmVjdGlvbihyZXF1ZXN0LmNvbm4pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBDb25zdW1lIHVucmVhZCBib2R5IGFuZCB0cmFpbGVycyBpZiByZWNlaXZlciBkaWRuJ3QgY29uc3VtZSB0aG9zZSBkYXRhXG4gICAgICBhd2FpdCByZXF1ZXN0LmZpbmFsaXplKCk7XG4gICAgfVxuXG4gICAgdGhpcy51bnRyYWNrQ29ubmVjdGlvbihjb25uKTtcbiAgICB0cnkge1xuICAgICAgY29ubi5jbG9zZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIC8vIG1pZ2h0IGhhdmUgYmVlbiBhbHJlYWR5IGNsb3NlZFxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgdHJhY2tDb25uZWN0aW9uKGNvbm46IERlbm8uQ29ubik6IHZvaWQge1xuICAgIHRoaXMuY29ubmVjdGlvbnMucHVzaChjb25uKTtcbiAgfVxuXG4gIHByaXZhdGUgdW50cmFja0Nvbm5lY3Rpb24oY29ubjogRGVuby5Db25uKTogdm9pZCB7XG4gICAgY29uc3QgaW5kZXggPSB0aGlzLmNvbm5lY3Rpb25zLmluZGV4T2YoY29ubik7XG4gICAgaWYgKGluZGV4ICE9PSAtMSkge1xuICAgICAgdGhpcy5jb25uZWN0aW9ucy5zcGxpY2UoaW5kZXgsIDEpO1xuICAgIH1cbiAgfVxuXG4gIC8vIEFjY2VwdHMgYSBuZXcgVENQIGNvbm5lY3Rpb24gYW5kIHlpZWxkcyBhbGwgSFRUUCByZXF1ZXN0cyB0aGF0IGFycml2ZSBvblxuICAvLyBpdC4gV2hlbiBhIGNvbm5lY3Rpb24gaXMgYWNjZXB0ZWQsIGl0IGFsc28gY3JlYXRlcyBhIG5ldyBpdGVyYXRvciBvZiB0aGVcbiAgLy8gc2FtZSBraW5kIGFuZCBhZGRzIGl0IHRvIHRoZSByZXF1ZXN0IG11bHRpcGxleGVyIHNvIHRoYXQgYW5vdGhlciBUQ1BcbiAgLy8gY29ubmVjdGlvbiBjYW4gYmUgYWNjZXB0ZWQuXG4gIHByaXZhdGUgYXN5bmMgKmFjY2VwdENvbm5BbmRJdGVyYXRlSHR0cFJlcXVlc3RzKFxuICAgIG11eDogTXV4QXN5bmNJdGVyYXRvcjxTZXJ2ZXJSZXF1ZXN0PixcbiAgKTogQXN5bmNJdGVyYWJsZUl0ZXJhdG9yPFNlcnZlclJlcXVlc3Q+IHtcbiAgICBpZiAodGhpcy5jbG9zaW5nKSByZXR1cm47XG4gICAgLy8gV2FpdCBmb3IgYSBuZXcgY29ubmVjdGlvbi5cbiAgICBsZXQgY29ubjogRGVuby5Db25uO1xuICAgIHRyeSB7XG4gICAgICBjb25uID0gYXdhaXQgdGhpcy5saXN0ZW5lci5hY2NlcHQoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKFxuICAgICAgICBlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLkJhZFJlc291cmNlIHx8XG4gICAgICAgIGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuSW52YWxpZERhdGEgfHxcbiAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5VbmV4cGVjdGVkRW9mXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIG11eC5hZGQodGhpcy5hY2NlcHRDb25uQW5kSXRlcmF0ZUh0dHBSZXF1ZXN0cyhtdXgpKTtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgICB0aGlzLnRyYWNrQ29ubmVjdGlvbihjb25uKTtcbiAgICAvLyBUcnkgdG8gYWNjZXB0IGFub3RoZXIgY29ubmVjdGlvbiBhbmQgYWRkIGl0IHRvIHRoZSBtdWx0aXBsZXhlci5cbiAgICBtdXguYWRkKHRoaXMuYWNjZXB0Q29ubkFuZEl0ZXJhdGVIdHRwUmVxdWVzdHMobXV4KSk7XG4gICAgLy8gWWllbGQgdGhlIHJlcXVlc3RzIHRoYXQgYXJyaXZlIG9uIHRoZSBqdXN0LWFjY2VwdGVkIGNvbm5lY3Rpb24uXG4gICAgeWllbGQqIHRoaXMuaXRlcmF0ZUh0dHBSZXF1ZXN0cyhjb25uKTtcbiAgfVxuXG4gIFtTeW1ib2wuYXN5bmNJdGVyYXRvcl0oKTogQXN5bmNJdGVyYWJsZUl0ZXJhdG9yPFNlcnZlclJlcXVlc3Q+IHtcbiAgICBjb25zdCBtdXg6IE11eEFzeW5jSXRlcmF0b3I8U2VydmVyUmVxdWVzdD4gPSBuZXcgTXV4QXN5bmNJdGVyYXRvcigpO1xuICAgIG11eC5hZGQodGhpcy5hY2NlcHRDb25uQW5kSXRlcmF0ZUh0dHBSZXF1ZXN0cyhtdXgpKTtcbiAgICByZXR1cm4gbXV4Lml0ZXJhdGUoKTtcbiAgfVxufVxuXG4vKiogT3B0aW9ucyBmb3IgY3JlYXRpbmcgYW4gSFRUUCBzZXJ2ZXIuICovXG5leHBvcnQgdHlwZSBIVFRQT3B0aW9ucyA9IE9taXQ8RGVuby5MaXN0ZW5PcHRpb25zLCBcInRyYW5zcG9ydFwiPjtcblxuLyoqXG4gKiBQYXJzZSBhZGRyIGZyb20gc3RyaW5nXG4gKlxuICogICAgIGNvbnN0IGFkZHIgPSBcIjo6MTo4MDAwXCI7XG4gKiAgICAgcGFyc2VBZGRyRnJvbVN0cmluZyhhZGRyKTtcbiAqXG4gKiBAcGFyYW0gYWRkciBBZGRyZXNzIHN0cmluZ1xuICovXG5leHBvcnQgZnVuY3Rpb24gX3BhcnNlQWRkckZyb21TdHIoYWRkcjogc3RyaW5nKTogSFRUUE9wdGlvbnMge1xuICBsZXQgdXJsOiBVUkw7XG4gIHRyeSB7XG4gICAgY29uc3QgaG9zdCA9IGFkZHIuc3RhcnRzV2l0aChcIjpcIikgPyBgMC4wLjAuMCR7YWRkcn1gIDogYWRkcjtcbiAgICB1cmwgPSBuZXcgVVJMKGBodHRwOi8vJHtob3N0fWApO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiSW52YWxpZCBhZGRyZXNzLlwiKTtcbiAgfVxuICBpZiAoXG4gICAgdXJsLnVzZXJuYW1lIHx8XG4gICAgdXJsLnBhc3N3b3JkIHx8XG4gICAgdXJsLnBhdGhuYW1lICE9IFwiL1wiIHx8XG4gICAgdXJsLnNlYXJjaCB8fFxuICAgIHVybC5oYXNoXG4gICkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJJbnZhbGlkIGFkZHJlc3MuXCIpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBob3N0bmFtZTogdXJsLmhvc3RuYW1lLFxuICAgIHBvcnQ6IHVybC5wb3J0ID09PSBcIlwiID8gODAgOiBOdW1iZXIodXJsLnBvcnQpLFxuICB9O1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIEhUVFAgc2VydmVyXG4gKlxuICogICAgIGltcG9ydCB7IHNlcnZlIH0gZnJvbSBcImh0dHBzOi8vZGVuby5sYW5kL3N0ZC9odHRwL3NlcnZlci50c1wiO1xuICogICAgIGNvbnN0IGJvZHkgPSBcIkhlbGxvIFdvcmxkXFxuXCI7XG4gKiAgICAgY29uc3Qgc2VydmVyID0gc2VydmUoeyBwb3J0OiA4MDAwIH0pO1xuICogICAgIGZvciBhd2FpdCAoY29uc3QgcmVxIG9mIHNlcnZlcikge1xuICogICAgICAgcmVxLnJlc3BvbmQoeyBib2R5IH0pO1xuICogICAgIH1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlcnZlKGFkZHI6IHN0cmluZyB8IEhUVFBPcHRpb25zKTogU2VydmVyIHtcbiAgaWYgKHR5cGVvZiBhZGRyID09PSBcInN0cmluZ1wiKSB7XG4gICAgYWRkciA9IF9wYXJzZUFkZHJGcm9tU3RyKGFkZHIpO1xuICB9XG5cbiAgY29uc3QgbGlzdGVuZXIgPSBEZW5vLmxpc3RlbihhZGRyKTtcbiAgcmV0dXJuIG5ldyBTZXJ2ZXIobGlzdGVuZXIpO1xufVxuXG4vKipcbiAqIFN0YXJ0IGFuIEhUVFAgc2VydmVyIHdpdGggZ2l2ZW4gb3B0aW9ucyBhbmQgcmVxdWVzdCBoYW5kbGVyXG4gKlxuICogICAgIGNvbnN0IGJvZHkgPSBcIkhlbGxvIFdvcmxkXFxuXCI7XG4gKiAgICAgY29uc3Qgb3B0aW9ucyA9IHsgcG9ydDogODAwMCB9O1xuICogICAgIGxpc3RlbkFuZFNlcnZlKG9wdGlvbnMsIChyZXEpID0+IHtcbiAqICAgICAgIHJlcS5yZXNwb25kKHsgYm9keSB9KTtcbiAqICAgICB9KTtcbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyBTZXJ2ZXIgY29uZmlndXJhdGlvblxuICogQHBhcmFtIGhhbmRsZXIgUmVxdWVzdCBoYW5kbGVyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsaXN0ZW5BbmRTZXJ2ZShcbiAgYWRkcjogc3RyaW5nIHwgSFRUUE9wdGlvbnMsXG4gIGhhbmRsZXI6IChyZXE6IFNlcnZlclJlcXVlc3QpID0+IHZvaWQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc2VydmVyID0gc2VydmUoYWRkcik7XG5cbiAgZm9yIGF3YWl0IChjb25zdCByZXF1ZXN0IG9mIHNlcnZlcikge1xuICAgIGhhbmRsZXIocmVxdWVzdCk7XG4gIH1cbn1cblxuLyoqIE9wdGlvbnMgZm9yIGNyZWF0aW5nIGFuIEhUVFBTIHNlcnZlci4gKi9cbmV4cG9ydCB0eXBlIEhUVFBTT3B0aW9ucyA9IE9taXQ8RGVuby5MaXN0ZW5UbHNPcHRpb25zLCBcInRyYW5zcG9ydFwiPjtcblxuLyoqXG4gKiBDcmVhdGUgYW4gSFRUUFMgc2VydmVyIHdpdGggZ2l2ZW4gb3B0aW9uc1xuICpcbiAqICAgICBjb25zdCBib2R5ID0gXCJIZWxsbyBIVFRQU1wiO1xuICogICAgIGNvbnN0IG9wdGlvbnMgPSB7XG4gKiAgICAgICBob3N0bmFtZTogXCJsb2NhbGhvc3RcIixcbiAqICAgICAgIHBvcnQ6IDQ0MyxcbiAqICAgICAgIGNlcnRGaWxlOiBcIi4vcGF0aC90by9sb2NhbGhvc3QuY3J0XCIsXG4gKiAgICAgICBrZXlGaWxlOiBcIi4vcGF0aC90by9sb2NhbGhvc3Qua2V5XCIsXG4gKiAgICAgfTtcbiAqICAgICBmb3IgYXdhaXQgKGNvbnN0IHJlcSBvZiBzZXJ2ZVRMUyhvcHRpb25zKSkge1xuICogICAgICAgcmVxLnJlc3BvbmQoeyBib2R5IH0pO1xuICogICAgIH1cbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyBTZXJ2ZXIgY29uZmlndXJhdGlvblxuICogQHJldHVybiBBc3luYyBpdGVyYWJsZSBzZXJ2ZXIgaW5zdGFuY2UgZm9yIGluY29taW5nIHJlcXVlc3RzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJ2ZVRMUyhvcHRpb25zOiBIVFRQU09wdGlvbnMpOiBTZXJ2ZXIge1xuICBjb25zdCB0bHNPcHRpb25zOiBEZW5vLkxpc3RlblRsc09wdGlvbnMgPSB7XG4gICAgLi4ub3B0aW9ucyxcbiAgICB0cmFuc3BvcnQ6IFwidGNwXCIsXG4gIH07XG4gIGNvbnN0IGxpc3RlbmVyID0gRGVuby5saXN0ZW5UbHModGxzT3B0aW9ucyk7XG4gIHJldHVybiBuZXcgU2VydmVyKGxpc3RlbmVyKTtcbn1cblxuLyoqXG4gKiBTdGFydCBhbiBIVFRQUyBzZXJ2ZXIgd2l0aCBnaXZlbiBvcHRpb25zIGFuZCByZXF1ZXN0IGhhbmRsZXJcbiAqXG4gKiAgICAgY29uc3QgYm9keSA9IFwiSGVsbG8gSFRUUFNcIjtcbiAqICAgICBjb25zdCBvcHRpb25zID0ge1xuICogICAgICAgaG9zdG5hbWU6IFwibG9jYWxob3N0XCIsXG4gKiAgICAgICBwb3J0OiA0NDMsXG4gKiAgICAgICBjZXJ0RmlsZTogXCIuL3BhdGgvdG8vbG9jYWxob3N0LmNydFwiLFxuICogICAgICAga2V5RmlsZTogXCIuL3BhdGgvdG8vbG9jYWxob3N0LmtleVwiLFxuICogICAgIH07XG4gKiAgICAgbGlzdGVuQW5kU2VydmVUTFMob3B0aW9ucywgKHJlcSkgPT4ge1xuICogICAgICAgcmVxLnJlc3BvbmQoeyBib2R5IH0pO1xuICogICAgIH0pO1xuICpcbiAqIEBwYXJhbSBvcHRpb25zIFNlcnZlciBjb25maWd1cmF0aW9uXG4gKiBAcGFyYW0gaGFuZGxlciBSZXF1ZXN0IGhhbmRsZXJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RlbkFuZFNlcnZlVExTKFxuICBvcHRpb25zOiBIVFRQU09wdGlvbnMsXG4gIGhhbmRsZXI6IChyZXE6IFNlcnZlclJlcXVlc3QpID0+IHZvaWQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc2VydmVyID0gc2VydmVUTFMob3B0aW9ucyk7XG5cbiAgZm9yIGF3YWl0IChjb25zdCByZXF1ZXN0IG9mIHNlcnZlcikge1xuICAgIGhhbmRsZXIocmVxdWVzdCk7XG4gIH1cbn1cblxuLyoqXG4gKiBJbnRlcmZhY2Ugb2YgSFRUUCBzZXJ2ZXIgcmVzcG9uc2UuXG4gKiBJZiBib2R5IGlzIGEgUmVhZGVyLCByZXNwb25zZSB3b3VsZCBiZSBjaHVua2VkLlxuICogSWYgYm9keSBpcyBhIHN0cmluZywgaXQgd291bGQgYmUgVVRGLTggZW5jb2RlZCBieSBkZWZhdWx0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlc3BvbnNlIHtcbiAgc3RhdHVzPzogbnVtYmVyO1xuICBoZWFkZXJzPzogSGVhZGVycztcbiAgYm9keT86IFVpbnQ4QXJyYXkgfCBEZW5vLlJlYWRlciB8IHN0cmluZztcbiAgdHJhaWxlcnM/OiAoKSA9PiBQcm9taXNlPEhlYWRlcnM+IHwgSGVhZGVycztcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwRUFBMEU7QUFDMUUsU0FBUyxNQUFNLFFBQVEsc0JBQXNCO0FBQzdDLFNBQVMsU0FBUyxFQUFFLFNBQVMsUUFBUSxpQkFBaUI7QUFDdEQsU0FBUyxNQUFNLFFBQVEscUJBQXFCO0FBQzVDLFNBQW1CLFFBQVEsRUFBRSxnQkFBZ0IsUUFBUSxrQkFBa0I7QUFDdkUsU0FDRSxVQUFVLEVBQ1YsaUJBQWlCLEVBQ2pCLFdBQVcsRUFDWCxXQUFXLEVBQ1gsYUFBYSxRQUNSLFdBQVc7QUFFbEIsT0FBTyxNQUFNO0lBQ1gsSUFBYTtJQUNiLE9BQWdCO0lBQ2hCLE1BQWU7SUFDZixXQUFvQjtJQUNwQixXQUFvQjtJQUNwQixRQUFrQjtJQUNsQixLQUFpQjtJQUNqQixFQUFjO0lBQ2QsRUFBYztJQUNkLE9BQW9DLFdBQVc7SUFFdkMsaUJBQTRDLFVBQVU7SUFDOUQ7OztHQUdDLEdBQ0QsSUFBSSxnQkFBK0I7UUFDakMsOEJBQThCO1FBQzlCLHNDQUFzQztRQUN0QyxJQUFJLElBQUksQ0FBQyxjQUFjLEtBQUssV0FBVztZQUNyQyxNQUFNLEtBQUssSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7WUFDNUIsSUFBSSxJQUFJO2dCQUNOLElBQUksQ0FBQyxjQUFjLEdBQUcsU0FBUztnQkFDL0IsOENBQThDO2dCQUM5QyxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxjQUFjLEdBQUc7b0JBQ3JDLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSTtnQkFDNUIsQ0FBQztZQUNI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