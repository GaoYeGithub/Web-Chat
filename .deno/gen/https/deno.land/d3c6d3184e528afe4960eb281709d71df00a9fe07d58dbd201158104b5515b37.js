// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
import { BufWriter } from "../io/bufio.ts";
import { TextProtoReader } from "../textproto/mod.ts";
import { assert } from "../_util/assert.ts";
import { encoder } from "../encoding/utf8.ts";
import { ServerRequest } from "./server.ts";
import { STATUS_TEXT } from "./http_status.ts";
export function emptyReader() {
    return {
        read (_) {
            return Promise.resolve(null);
        }
    };
}
export function bodyReader(contentLength, r) {
    let totalRead = 0;
    let finished = false;
    async function read(buf) {
        if (finished) return null;
        let result;
        const remaining = contentLength - totalRead;
        if (remaining >= buf.byteLength) {
            result = await r.read(buf);
        } else {
            const readBuf = buf.subarray(0, remaining);
            result = await r.read(readBuf);
        }
        if (result !== null) {
            totalRead += result;
        }
        finished = totalRead === contentLength;
        return result;
    }
    return {
        read
    };
}
export function chunkedBodyReader(h, r) {
    // Based on https://tools.ietf.org/html/rfc2616#section-19.4.6
    const tp = new TextProtoReader(r);
    let finished = false;
    const chunks = [];
    async function read(buf) {
        if (finished) return null;
        const [chunk] = chunks;
        if (chunk) {
            const chunkRemaining = chunk.data.byteLength - chunk.offset;
            const readLength = Math.min(chunkRemaining, buf.byteLength);
            for(let i = 0; i < readLength; i++){
                buf[i] = chunk.data[chunk.offset + i];
            }
            chunk.offset += readLength;
            if (chunk.offset === chunk.data.byteLength) {
                chunks.shift();
                // Consume \r\n;
                if (await tp.readLine() === null) {
                    throw new Deno.errors.UnexpectedEof();
                }
            }
            return readLength;
        }
        const line = await tp.readLine();
        if (line === null) throw new Deno.errors.UnexpectedEof();
        // TODO: handle chunk extension
        const [chunkSizeString] = line.split(";");
        const chunkSize = parseInt(chunkSizeString, 16);
        if (Number.isNaN(chunkSize) || chunkSize < 0) {
            throw new Error("Invalid chunk size");
        }
        if (chunkSize > 0) {
            if (chunkSize > buf.byteLength) {
                let eof = await r.readFull(buf);
                if (eof === null) {
                    throw new Deno.errors.UnexpectedEof();
                }
                const restChunk = new Uint8Array(chunkSize - buf.byteLength);
                eof = await r.readFull(restChunk);
                if (eof === null) {
                    throw new Deno.errors.UnexpectedEof();
                } else {
                    chunks.push({
                        offset: 0,
                        data: restChunk
                    });
                }
                return buf.byteLength;
            } else {
                const bufToFill = buf.subarray(0, chunkSize);
                const eof = await r.readFull(bufToFill);
                if (eof === null) {
                    throw new Deno.errors.UnexpectedEof();
                }
                // Consume \r\n
                if (await tp.readLine() === null) {
                    throw new Deno.errors.UnexpectedEof();
                }
                return chunkSize;
            }
        } else {
            assert(chunkSize === 0);
            // Consume \r\n
            if (await r.readLine() === null) {
                throw new Deno.errors.UnexpectedEof();
            }
            await readTrailers(h, r);
            finished = true;
            return null;
        }
    }
    return {
        read
    };
}
function isProhibidedForTrailer(key) {
    const s = new Set([
        "transfer-encoding",
        "content-length",
        "trailer"
    ]);
    return s.has(key.toLowerCase());
}
/** Read trailer headers from reader and append values to headers. "trailer"
 * field will be deleted. */ export async function readTrailers(headers, r) {
    const trailers = parseTrailer(headers.get("trailer"));
    if (trailers == null) return;
    const trailerNames = [
        ...trailers.keys()
    ];
    const tp = new TextProtoReader(r);
    const result = await tp.readMIMEHeader();
    if (result == null) {
        throw new Deno.errors.InvalidData("Missing trailer header.");
    }
    const undeclared = [
        ...result.keys()
    ].filter((k)=>!trailerNames.includes(k));
    if (undeclared.length > 0) {
        throw new Deno.errors.InvalidData(`Undeclared trailers: ${Deno.inspect(undeclared)}.`);
    }
    for (const [k, v] of result){
        headers.append(k, v);
    }
    const missingTrailers = trailerNames.filter((k)=>!result.has(k));
    if (missingTrailers.length > 0) {
        throw new Deno.errors.InvalidData(`Missing trailers: ${Deno.inspect(missingTrailers)}.`);
    }
    headers.delete("trailer");
}
function parseTrailer(field) {
    if (field == null) {
        return undefined;
    }
    const trailerNames = field.split(",").map((v)=>v.trim().toLowerCase());
    if (trailerNames.length === 0) {
        throw new Deno.errors.InvalidData("Empty trailer header.");
    }
    const prohibited = trailerNames.filter((k)=>isProhibidedForTrailer(k));
    if (prohibited.length > 0) {
        throw new Deno.errors.InvalidData(`Prohibited trailer names: ${Deno.inspect(prohibited)}.`);
    }
    return new Headers(trailerNames.map((key)=>[
            key,
            ""
        ]));
}
export async function writeChunkedBody(w, r) {
    const writer = BufWriter.create(w);
    for await (const chunk of Deno.iter(r)){
        if (chunk.byteLength <= 0) continue;
        const start = encoder.encode(`${chunk.byteLength.toString(16)}\r\n`);
        const end = encoder.encode("\r\n");
        await writer.write(start);
        await writer.write(chunk);
        await writer.write(end);
    }
    const endChunk = encoder.encode("0\r\n\r\n");
    await writer.write(endChunk);
}
/** Write trailer headers to writer. It should mostly should be called after
 * `writeResponse()`. */ export async function writeTrailers(w, headers, trailers) {
    const trailer = headers.get("trailer");
    if (trailer === null) {
        throw new TypeError("Missing trailer header.");
    }
    const transferEncoding = headers.get("transfer-encoding");
    if (transferEncoding === null || !transferEncoding.match(/^chunked/)) {
        throw new TypeError(`Trailers are only allowed for "transfer-encoding: chunked", got "transfer-encoding: ${transferEncoding}".`);
    }
    const writer = BufWriter.create(w);
    const trailerNames = trailer.split(",").map((s)=>s.trim().toLowerCase());
    const prohibitedTrailers = trailerNames.filter((k)=>isProhibidedForTrailer(k));
    if (prohibitedTrailers.length > 0) {
        throw new TypeError(`Prohibited trailer names: ${Deno.inspect(prohibitedTrailers)}.`);
    }
    const undeclared = [
        ...trailers.keys()
    ].filter((k)=>!trailerNames.includes(k));
    if (undeclared.length > 0) {
        throw new TypeError(`Undeclared trailers: ${Deno.inspect(undeclared)}.`);
    }
    for (const [key, value] of trailers){
        await writer.write(encoder.encode(`${key}: ${value}\r\n`));
    }
    await writer.write(encoder.encode("\r\n"));
    await writer.flush();
}
export async function writeResponse(w, r) {
    const protoMajor = 1;
    const protoMinor = 1;
    const statusCode = r.status || 200;
    const statusText = STATUS_TEXT.get(statusCode);
    const writer = BufWriter.create(w);
    if (!statusText) {
        throw new Deno.errors.InvalidData("Bad status code");
    }
    if (!r.body) {
        r.body = new Uint8Array();
    }
    if (typeof r.body === "string") {
        r.body = encoder.encode(r.body);
    }
    let out = `HTTP/${protoMajor}.${protoMinor} ${statusCode} ${statusText}\r\n`;
    const headers = r.headers ?? new Headers();
    if (r.body && !headers.get("content-length")) {
        if (r.body instanceof Uint8Array) {
            out += `content-length: ${r.body.byteLength}\r\n`;
        } else if (!headers.get("transfer-encoding")) {
            out += "transfer-encoding: chunked\r\n";
        }
    }
    for (const [key, value] of headers){
        out += `${key}: ${value}\r\n`;
    }
    out += `\r\n`;
    const header = encoder.encode(out);
    const n = await writer.write(header);
    assert(n === header.byteLength);
    if (r.body instanceof Uint8Array) {
        const n = await writer.write(r.body);
        assert(n === r.body.byteLength);
    } else if (headers.has("content-length")) {
        const contentLength = headers.get("content-length");
        assert(contentLength != null);
        const bodyLength = parseInt(contentLength);
        const n = await Deno.copy(r.body, writer);
        assert(n === bodyLength);
    } else {
        await writeChunkedBody(writer, r.body);
    }
    if (r.trailers) {
        const t = await r.trailers();
        await writeTrailers(writer, headers, t);
    }
    await writer.flush();
}
/**
 * ParseHTTPVersion parses a HTTP version string.
 * "HTTP/1.0" returns (1, 0).
 * Ported from https://github.com/golang/go/blob/f5c43b9/src/net/http/request.go#L766-L792
 */ export function parseHTTPVersion(vers) {
    switch(vers){
        case "HTTP/1.1":
            return [
                1,
                1
            ];
        case "HTTP/1.0":
            return [
                1,
                0
            ];
        default:
            {
                const Big = 1000000; // arbitrary upper bound
                if (!vers.startsWith("HTTP/")) {
                    break;
                }
                const dot = vers.indexOf(".");
                if (dot < 0) {
                    break;
                }
                const majorStr = vers.substring(vers.indexOf("/") + 1, dot);
                const major = Number(majorStr);
                if (!Number.isInteger(major) || major < 0 || major > Big) {
                    break;
                }
                const minorStr = vers.substring(dot + 1);
                const minor = Number(minorStr);
                if (!Number.isInteger(minor) || minor < 0 || minor > Big) {
                    break;
                }
                return [
                    major,
                    minor
                ];
            }
    }
    throw new Error(`malformed HTTP version ${vers}`);
}
export async function readRequest(conn, bufr) {
    const tp = new TextProtoReader(bufr);
    const firstLine = await tp.readLine(); // e.g. GET /index.html HTTP/1.0
    if (firstLine === null) return null;
    const headers = await tp.readMIMEHeader();
    if (headers === null) throw new Deno.errors.UnexpectedEof();
    const req = new ServerRequest();
    req.conn = conn;
    req.r = bufr;
    [req.method, req.url, req.proto] = firstLine.split(" ", 3);
    [req.protoMinor, req.protoMajor] = parseHTTPVersion(req.proto);
    req.headers = headers;
    fixLength(req);
    return req;
}
function fixLength(req) {
    const contentLength = req.headers.get("Content-Length");
    if (contentLength) {
        const arrClen = contentLength.split(",");
        if (arrClen.length > 1) {
            const distinct = [
                ...new Set(arrClen.map((e)=>e.trim()))
            ];
            if (distinct.length > 1) {
                throw Error("cannot contain multiple Content-Length headers");
            } else {
                req.headers.set("Content-Length", distinct[0]);
            }
        }
        const c = req.headers.get("Content-Length");
        if (req.method === "HEAD" && c && c !== "0") {
            throw Error("http: method cannot contain a Content-Length");
        }
        if (c && req.headers.has("transfer-encoding")) {
            // A sender MUST NOT send a Content-Length header field in any message
            // that contains a Transfer-Encoding header field.
            // rfc: https://tools.ietf.org/html/rfc7230#section-3.3.2
            throw new Error("http: Transfer-Encoding and Content-Length cannot be send together");
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvaHR0cC9faW8udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyMCB0aGUgRGVubyBhdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLiBNSVQgbGljZW5zZS5cbmltcG9ydCB7IEJ1ZlJlYWRlciwgQnVmV3JpdGVyIH0gZnJvbSBcIi4uL2lvL2J1ZmlvLnRzXCI7XG5pbXBvcnQgeyBUZXh0UHJvdG9SZWFkZXIgfSBmcm9tIFwiLi4vdGV4dHByb3RvL21vZC50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0IH0gZnJvbSBcIi4uL191dGlsL2Fzc2VydC50c1wiO1xuaW1wb3J0IHsgZW5jb2RlciB9IGZyb20gXCIuLi9lbmNvZGluZy91dGY4LnRzXCI7XG5pbXBvcnQgeyBSZXNwb25zZSwgU2VydmVyUmVxdWVzdCB9IGZyb20gXCIuL3NlcnZlci50c1wiO1xuaW1wb3J0IHsgU1RBVFVTX1RFWFQgfSBmcm9tIFwiLi9odHRwX3N0YXR1cy50c1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gZW1wdHlSZWFkZXIoKTogRGVuby5SZWFkZXIge1xuICByZXR1cm4ge1xuICAgIHJlYWQoXzogVWludDhBcnJheSk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShudWxsKTtcbiAgICB9LFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYm9keVJlYWRlcihjb250ZW50TGVuZ3RoOiBudW1iZXIsIHI6IEJ1ZlJlYWRlcik6IERlbm8uUmVhZGVyIHtcbiAgbGV0IHRvdGFsUmVhZCA9IDA7XG4gIGxldCBmaW5pc2hlZCA9IGZhbHNlO1xuICBhc3luYyBmdW5jdGlvbiByZWFkKGJ1ZjogVWludDhBcnJheSk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICAgIGlmIChmaW5pc2hlZCkgcmV0dXJuIG51bGw7XG4gICAgbGV0IHJlc3VsdDogbnVtYmVyIHwgbnVsbDtcbiAgICBjb25zdCByZW1haW5pbmcgPSBjb250ZW50TGVuZ3RoIC0gdG90YWxSZWFkO1xuICAgIGlmIChyZW1haW5pbmcgPj0gYnVmLmJ5dGVMZW5ndGgpIHtcbiAgICAgIHJlc3VsdCA9IGF3YWl0IHIucmVhZChidWYpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCByZWFkQnVmID0gYnVmLnN1YmFycmF5KDAsIHJlbWFpbmluZyk7XG4gICAgICByZXN1bHQgPSBhd2FpdCByLnJlYWQocmVhZEJ1Zik7XG4gICAgfVxuICAgIGlmIChyZXN1bHQgIT09IG51bGwpIHtcbiAgICAgIHRvdGFsUmVhZCArPSByZXN1bHQ7XG4gICAgfVxuICAgIGZpbmlzaGVkID0gdG90YWxSZWFkID09PSBjb250ZW50TGVuZ3RoO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbiAgcmV0dXJuIHsgcmVhZCB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2h1bmtlZEJvZHlSZWFkZXIoaDogSGVhZGVycywgcjogQnVmUmVhZGVyKTogRGVuby5SZWFkZXIge1xuICAvLyBCYXNlZCBvbiBodHRwczovL3Rvb2xzLmlldGYub3JnL2h0bWwvcmZjMjYxNiNzZWN0aW9uLTE5LjQuNlxuICBjb25zdCB0cCA9IG5ldyBUZXh0UHJvdG9SZWFkZXIocik7XG4gIGxldCBmaW5pc2hlZCA9IGZhbHNlO1xuICBjb25zdCBjaHVua3M6IEFycmF5PHtcbiAgICBvZmZzZXQ6IG51bWJlcjtcbiAgICBkYXRhOiBVaW50OEFycmF5O1xuICB9PiA9IFtdO1xuICBhc3luYyBmdW5jdGlvbiByZWFkKGJ1ZjogVWludDhBcnJheSk6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICAgIGlmIChmaW5pc2hlZCkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgW2NodW5rXSA9IGNodW5rcztcbiAgICBpZiAoY2h1bmspIHtcbiAgICAgIGNvbnN0IGNodW5rUmVtYWluaW5nID0gY2h1bmsuZGF0YS5ieXRlTGVuZ3RoIC0gY2h1bmsub2Zmc2V0O1xuICAgICAgY29uc3QgcmVhZExlbmd0aCA9IE1hdGgubWluKGNodW5rUmVtYWluaW5nLCBidWYuYnl0ZUxlbmd0aCk7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJlYWRMZW5ndGg7IGkrKykge1xuICAgICAgICBidWZbaV0gPSBjaHVuay5kYXRhW2NodW5rLm9mZnNldCArIGldO1xuICAgICAgfVxuICAgICAgY2h1bmsub2Zmc2V0ICs9IHJlYWRMZW5ndGg7XG4gICAgICBpZiAoY2h1bmsub2Zmc2V0ID09PSBjaHVuay5kYXRhLmJ5dGVMZW5ndGgpIHtcbiAgICAgICAgY2h1bmtzLnNoaWZ0KCk7XG4gICAgICAgIC8vIENvbnN1bWUgXFxyXFxuO1xuICAgICAgICBpZiAoKGF3YWl0IHRwLnJlYWRMaW5lKCkpID09PSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIHJlYWRMZW5ndGg7XG4gICAgfVxuICAgIGNvbnN0IGxpbmUgPSBhd2FpdCB0cC5yZWFkTGluZSgpO1xuICAgIGlmIChsaW5lID09PSBudWxsKSB0aHJvdyBuZXcgRGVuby5lcnJvcnMuVW5leHBlY3RlZEVvZigpO1xuICAgIC8vIFRPRE86IGhhbmRsZSBjaHVuayBleHRlbnNpb25cbiAgICBjb25zdCBbY2h1bmtTaXplU3RyaW5nXSA9IGxpbmUuc3BsaXQoXCI7XCIpO1xuICAgIGNvbnN0IGNodW5rU2l6ZSA9IHBhcnNlSW50KGNodW5rU2l6ZVN0cmluZywgMTYpO1xuICAgIGlmIChOdW1iZXIuaXNOYU4oY2h1bmtTaXplKSB8fCBjaHVua1NpemUgPCAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGNodW5rIHNpemVcIik7XG4gICAgfVxuICAgIGlmIChjaHVua1NpemUgPiAwKSB7XG4gICAgICBpZiAoY2h1bmtTaXplID4gYnVmLmJ5dGVMZW5ndGgpIHtcbiAgICAgICAgbGV0IGVvZiA9IGF3YWl0IHIucmVhZEZ1bGwoYnVmKTtcbiAgICAgICAgaWYgKGVvZiA9PT0gbnVsbCkge1xuICAgICAgICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5VbmV4cGVjdGVkRW9mKCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdENodW5rID0gbmV3IFVpbnQ4QXJyYXkoY2h1bmtTaXplIC0gYnVmLmJ5dGVMZW5ndGgpO1xuICAgICAgICBlb2YgPSBhd2FpdCByLnJlYWRGdWxsKHJlc3RDaHVuayk7XG4gICAgICAgIGlmIChlb2YgPT09IG51bGwpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRGVuby5lcnJvcnMuVW5leHBlY3RlZEVvZigpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNodW5rcy5wdXNoKHtcbiAgICAgICAgICAgIG9mZnNldDogMCxcbiAgICAgICAgICAgIGRhdGE6IHJlc3RDaHVuayxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYnVmLmJ5dGVMZW5ndGg7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBidWZUb0ZpbGwgPSBidWYuc3ViYXJyYXkoMCwgY2h1bmtTaXplKTtcbiAgICAgICAgY29uc3QgZW9mID0gYXdhaXQgci5yZWFkRnVsbChidWZUb0ZpbGwpO1xuICAgICAgICBpZiAoZW9mID09PSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBDb25zdW1lIFxcclxcblxuICAgICAgICBpZiAoKGF3YWl0IHRwLnJlYWRMaW5lKCkpID09PSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY2h1bmtTaXplO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBhc3NlcnQoY2h1bmtTaXplID09PSAwKTtcbiAgICAgIC8vIENvbnN1bWUgXFxyXFxuXG4gICAgICBpZiAoKGF3YWl0IHIucmVhZExpbmUoKSkgPT09IG51bGwpIHtcbiAgICAgICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHJlYWRUcmFpbGVycyhoLCByKTtcbiAgICAgIGZpbmlzaGVkID0gdHJ1ZTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyByZWFkIH07XG59XG5cbmZ1bmN0aW9uIGlzUHJvaGliaWRlZEZvclRyYWlsZXIoa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgcyA9IG5ldyBTZXQoW1widHJhbnNmZXItZW5jb2RpbmdcIiwgXCJjb250ZW50LWxlbmd0aFwiLCBcInRyYWlsZXJcIl0pO1xuICByZXR1cm4gcy5oYXMoa2V5LnRvTG93ZXJDYXNlKCkpO1xufVxuXG4vKiogUmVhZCB0cmFpbGVyIGhlYWRlcnMgZnJvbSByZWFkZXIgYW5kIGFwcGVuZCB2YWx1ZXMgdG8gaGVhZGVycy4gXCJ0cmFpbGVyXCJcbiAqIGZpZWxkIHdpbGwgYmUgZGVsZXRlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkVHJhaWxlcnMoXG4gIGhlYWRlcnM6IEhlYWRlcnMsXG4gIHI6IEJ1ZlJlYWRlcixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0cmFpbGVycyA9IHBhcnNlVHJhaWxlcihoZWFkZXJzLmdldChcInRyYWlsZXJcIikpO1xuICBpZiAodHJhaWxlcnMgPT0gbnVsbCkgcmV0dXJuO1xuICBjb25zdCB0cmFpbGVyTmFtZXMgPSBbLi4udHJhaWxlcnMua2V5cygpXTtcbiAgY29uc3QgdHAgPSBuZXcgVGV4dFByb3RvUmVhZGVyKHIpO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCB0cC5yZWFkTUlNRUhlYWRlcigpO1xuICBpZiAocmVzdWx0ID09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRGVuby5lcnJvcnMuSW52YWxpZERhdGEoXCJNaXNzaW5nIHRyYWlsZXIgaGVhZGVyLlwiKTtcbiAgfVxuICBjb25zdCB1bmRlY2xhcmVkID0gWy4uLnJlc3VsdC5rZXlzKCldLmZpbHRlcihcbiAgICAoaykgPT4gIXRyYWlsZXJOYW1lcy5pbmNsdWRlcyhrKSxcbiAgKTtcbiAgaWYgKHVuZGVjbGFyZWQubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5JbnZhbGlkRGF0YShcbiAgICAgIGBVbmRlY2xhcmVkIHRyYWlsZXJzOiAke0Rlbm8uaW5zcGVjdCh1bmRlY2xhcmVkKX0uYCxcbiAgICApO1xuICB9XG4gIGZvciAoY29uc3QgW2ssIHZdIG9mIHJlc3VsdCkge1xuICAgIGhlYWRlcnMuYXBwZW5kKGssIHYpO1xuICB9XG4gIGNvbnN0IG1pc3NpbmdUcmFpbGVycyA9IHRyYWlsZXJOYW1lcy5maWx0ZXIoKGspID0+ICFyZXN1bHQuaGFzKGspKTtcbiAgaWYgKG1pc3NpbmdUcmFpbGVycy5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLkludmFsaWREYXRhKFxuICAgICAgYE1pc3NpbmcgdHJhaWxlcnM6ICR7RGVuby5pbnNwZWN0KG1pc3NpbmdUcmFpbGVycyl9LmAsXG4gICAgKTtcbiAgfVxuICBoZWFkZXJzLmRlbGV0ZShcInRyYWlsZXJcIik7XG59XG5cbmZ1bmN0aW9uIHBhcnNlVHJhaWxlcihmaWVsZDogc3RyaW5nIHwgbnVsbCk6IEhlYWRlcnMgfCB1bmRlZmluZWQge1xuICBpZiAoZmllbGQgPT0gbnVsbCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgY29uc3QgdHJhaWxlck5hbWVzID0gZmllbGQuc3BsaXQoXCIsXCIpLm1hcCgodikgPT4gdi50cmltKCkudG9Mb3dlckNhc2UoKSk7XG4gIGlmICh0cmFpbGVyTmFtZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLkludmFsaWREYXRhKFwiRW1wdHkgdHJhaWxlciBoZWFkZXIuXCIpO1xuICB9XG4gIGNvbnN0IHByb2hpYml0ZWQgPSB0cmFpbGVyTmFtZXMuZmlsdGVyKChrKSA9PiBpc1Byb2hpYmlkZWRGb3JUcmFpbGVyKGspKTtcbiAgaWYgKHByb2hpYml0ZWQubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5JbnZhbGlkRGF0YShcbiAgICAgIGBQcm9oaWJpdGVkIHRyYWlsZXIgbmFtZXM6ICR7RGVuby5pbnNwZWN0KHByb2hpYml0ZWQpfS5gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5ldyBIZWFkZXJzKHRyYWlsZXJOYW1lcy5tYXAoKGtleSkgPT4gW2tleSwgXCJcIl0pKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlQ2h1bmtlZEJvZHkoXG4gIHc6IERlbm8uV3JpdGVyLFxuICByOiBEZW5vLlJlYWRlcixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3cml0ZXIgPSBCdWZXcml0ZXIuY3JlYXRlKHcpO1xuICBmb3IgYXdhaXQgKGNvbnN0IGNodW5rIG9mIERlbm8uaXRlcihyKSkge1xuICAgIGlmIChjaHVuay5ieXRlTGVuZ3RoIDw9IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IHN0YXJ0ID0gZW5jb2Rlci5lbmNvZGUoYCR7Y2h1bmsuYnl0ZUxlbmd0aC50b1N0cmluZygxNil9XFxyXFxuYCk7XG4gICAgY29uc3QgZW5kID0gZW5jb2Rlci5lbmNvZGUoXCJcXHJcXG5cIik7XG4gICAgYXdhaXQgd3JpdGVyLndyaXRlKHN0YXJ0KTtcbiAgICBhd2FpdCB3cml0ZXIud3JpdGUoY2h1bmspO1xuICAgIGF3YWl0IHdyaXRlci53cml0ZShlbmQpO1xuICB9XG5cbiAgY29uc3QgZW5kQ2h1bmsgPSBlbmNvZGVyLmVuY29kZShcIjBcXHJcXG5cXHJcXG5cIik7XG4gIGF3YWl0IHdyaXRlci53cml0ZShlbmRDaHVuayk7XG59XG5cbi8qKiBXcml0ZSB0cmFpbGVyIGhlYWRlcnMgdG8gd3JpdGVyLiBJdCBzaG91bGQgbW9zdGx5IHNob3VsZCBiZSBjYWxsZWQgYWZ0ZXJcbiAqIGB3cml0ZVJlc3BvbnNlKClgLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlVHJhaWxlcnMoXG4gIHc6IERlbm8uV3JpdGVyLFxuICBoZWFkZXJzOiBIZWFkZXJzLFxuICB0cmFpbGVyczogSGVhZGVycyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0cmFpbGVyID0gaGVhZGVycy5nZXQoXCJ0cmFpbGVyXCIpO1xuICBpZiAodHJhaWxlciA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJNaXNzaW5nIHRyYWlsZXIgaGVhZGVyLlwiKTtcbiAgfVxuICBjb25zdCB0cmFuc2ZlckVuY29kaW5nID0gaGVhZGVycy5nZXQoXCJ0cmFuc2Zlci1lbmNvZGluZ1wiKTtcbiAgaWYgKHRyYW5zZmVyRW5jb2RpbmcgPT09IG51bGwgfHwgIXRyYW5zZmVyRW5jb2RpbmcubWF0Y2goL15jaHVua2VkLykpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFxuICAgICAgYFRyYWlsZXJzIGFyZSBvbmx5IGFsbG93ZWQgZm9yIFwidHJhbnNmZXItZW5jb2Rpbmc6IGNodW5rZWRcIiwgZ290IFwidHJhbnNmZXItZW5jb2Rpbmc6ICR7dHJhbnNmZXJFbmNvZGluZ31cIi5gLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgd3JpdGVyID0gQnVmV3JpdGVyLmNyZWF0ZSh3KTtcbiAgY29uc3QgdHJhaWxlck5hbWVzID0gdHJhaWxlci5zcGxpdChcIixcIikubWFwKChzKSA9PiBzLnRyaW0oKS50b0xvd2VyQ2FzZSgpKTtcbiAgY29uc3QgcHJvaGliaXRlZFRyYWlsZXJzID0gdHJhaWxlck5hbWVzLmZpbHRlcigoaykgPT5cbiAgICBpc1Byb2hpYmlkZWRGb3JUcmFpbGVyKGspXG4gICk7XG4gIGlmIChwcm9oaWJpdGVkVHJhaWxlcnMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICBgUHJvaGliaXRlZCB0cmFpbGVyIG5hbWVzOiAke0Rlbm8uaW5zcGVjdChwcm9oaWJpdGVkVHJhaWxlcnMpfS5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdW5kZWNsYXJlZCA9IFsuLi50cmFpbGVycy5rZXlzKCldLmZpbHRlcihcbiAgICAoaykgPT4gIXRyYWlsZXJOYW1lcy5pbmNsdWRlcyhrKSxcbiAgKTtcbiAgaWYgKHVuZGVjbGFyZWQubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoYFVuZGVjbGFyZWQgdHJhaWxlcnM6ICR7RGVuby5pbnNwZWN0KHVuZGVjbGFyZWQpfS5gKTtcbiAgfVxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiB0cmFpbGVycykge1xuICAgIGF3YWl0IHdyaXRlci53cml0ZShlbmNvZGVyLmVuY29kZShgJHtrZXl9OiAke3ZhbHVlfVxcclxcbmApKTtcbiAgfVxuICBhd2FpdCB3cml0ZXIud3JpdGUoZW5jb2Rlci5lbmNvZGUoXCJcXHJcXG5cIikpO1xuICBhd2FpdCB3cml0ZXIuZmx1c2goKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlUmVzcG9uc2UoXG4gIHc6IERlbm8uV3JpdGVyLFxuICByOiBSZXNwb25zZSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBwcm90b01ham9yID0gMTtcbiAgY29uc3QgcHJvdG9NaW5vciA9IDE7XG4gIGNvbnN0IHN0YXR1c0NvZGUgPSByLnN0YXR1cyB8fCAyMDA7XG4gIGNvbnN0IHN0YXR1c1RleHQgPSBTVEFUVVNfVEVYVC5nZXQoc3RhdHVzQ29kZSk7XG4gIGNvbnN0IHdyaXRlciA9IEJ1ZldyaXRlci5jcmVhdGUodyk7XG4gIGlmICghc3RhdHVzVGV4dCkge1xuICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5JbnZhbGlkRGF0YShcIkJhZCBzdGF0dXMgY29kZVwiKTtcbiAgfVxuICBpZiAoIXIuYm9keSkge1xuICAgIHIuYm9keSA9IG5ldyBVaW50OEFycmF5KCk7XG4gIH1cbiAgaWYgKHR5cGVvZiByLmJvZHkgPT09IFwic3RyaW5nXCIpIHtcbiAgICByLmJvZHkgPSBlbmNvZGVyLmVuY29kZShyLmJvZHkpO1xuICB9XG5cbiAgbGV0IG91dCA9IGBIVFRQLyR7cHJvdG9NYWpvcn0uJHtwcm90b01pbm9yfSAke3N0YXR1c0NvZGV9ICR7c3RhdHVzVGV4dH1cXHJcXG5gO1xuXG4gIGNvbnN0IGhlYWRlcnMgPSByLmhlYWRlcnMgPz8gbmV3IEhlYWRlcnMoKTtcblxuICBpZiAoci5ib2R5ICYmICFoZWFkZXJzLmdldChcImNvbnRlbnQtbGVuZ3RoXCIpKSB7XG4gICAgaWYgKHIuYm9keSBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkpIHtcbiAgICAgIG91dCArPSBgY29udGVudC1sZW5ndGg6ICR7ci5ib2R5LmJ5dGVMZW5ndGh9XFxyXFxuYDtcbiAgICB9IGVsc2UgaWYgKCFoZWFkZXJzLmdldChcInRyYW5zZmVyLWVuY29kaW5nXCIpKSB7XG4gICAgICBvdXQgKz0gXCJ0cmFuc2Zlci1lbmNvZGluZzogY2h1bmtlZFxcclxcblwiO1xuICAgIH1cbiAgfVxuXG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGhlYWRlcnMpIHtcbiAgICBvdXQgKz0gYCR7a2V5fTogJHt2YWx1ZX1cXHJcXG5gO1xuICB9XG5cbiAgb3V0ICs9IGBcXHJcXG5gO1xuXG4gIGNvbnN0IGhlYWRlciA9IGVuY29kZXIuZW5jb2RlKG91dCk7XG4gIGNvbnN0IG4gPSBhd2FpdCB3cml0ZXIud3JpdGUoaGVhZGVyKTtcbiAgYXNzZXJ0KG4gPT09IGhlYWRlci5ieXRlTGVuZ3RoKTtcblxuICBpZiAoci5ib2R5IGluc3RhbmNlb2YgVWludDhBcnJheSkge1xuICAgIGNvbnN0IG4gPSBhd2FpdCB3cml0ZXIud3JpdGUoci5ib2R5KTtcbiAgICBhc3NlcnQobiA9PT0gci5ib2R5LmJ5dGVMZW5ndGgpO1xuICB9IGVsc2UgaWYgKGhlYWRlcnMuaGFzKFwiY29udGVudC1sZW5ndGhcIikpIHtcbiAgICBjb25zdCBjb250ZW50TGVuZ3RoID0gaGVhZGVycy5nZXQoXCJjb250ZW50LWxlbmd0aFwiKTtcbiAgICBhc3NlcnQoY29udGVudExlbmd0aCAhPSBudWxsKTtcbiAgICBjb25zdCBib2R5TGVuZ3RoID0gcGFyc2VJbnQoY29udGVudExlbmd0aCk7XG4gICAgY29uc3QgbiA9IGF3YWl0IERlbm8uY29weShyLmJvZHksIHdyaXRlcik7XG4gICAgYXNzZXJ0KG4gPT09IGJvZHlMZW5ndGgpO1xuICB9IGVsc2Uge1xuICAgIGF3YWl0IHdyaXRlQ2h1bmtlZEJvZHkod3JpdGVyLCByLmJvZHkpO1xuICB9XG4gIGlmIChyLnRyYWlsZXJzKSB7XG4gICAgY29uc3QgdCA9IGF3YWl0IHIudHJhaWxlcnMoKTtcbiAgICBhd2FpdCB3cml0ZVRyYWlsZXJzKHdyaXRlciwgaGVhZGVycywgdCk7XG4gIH1cbiAgYXdhaXQgd3JpdGVyLmZsdXNoKCk7XG59XG5cbi8qKlxuICogUGFyc2VIVFRQVmVyc2lvbiBwYXJzZXMgYSBIVFRQIHZlcnNpb24gc3RyaW5nLlxuICogXCJIVFRQLzEuMFwiIHJldHVybnMgKDEsIDApLlxuICogUG9ydGVkIGZyb20gaHR0cHM6Ly9naXRodWIuY29tL2dvbGFuZy9nby9ibG9iL2Y1YzQzYjkvc3JjL25ldC9odHRwL3JlcXVlc3QuZ28jTDc2Ni1MNzkyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUhUVFBWZXJzaW9uKHZlcnM6IHN0cmluZyk6IFtudW1iZXIsIG51bWJlcl0ge1xuICBzd2l0Y2ggKHZlcnMpIHtcbiAgICBjYXNlIFwiSFRUUC8xLjFcIjpcbiAgICAgIHJldHVybiBbMSwgMV07XG5cbiAgICBjYXNlIFwiSFRUUC8xLjBcIjpcbiAgICAgIHJldHVybiBbMSwgMF07XG5cbiAgICBkZWZhdWx0OiB7XG4gICAgICBjb25zdCBCaWcgPSAxMDAwMDAwOyAvLyBhcmJpdHJhcnkgdXBwZXIgYm91bmRcblxuICAgICAgaWYgKCF2ZXJzLnN0YXJ0c1dpdGgoXCJIVFRQL1wiKSkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY29uc3QgZG90ID0gdmVycy5pbmRleE9mKFwiLlwiKTtcbiAgICAgIGlmIChkb3QgPCAwKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYWpvclN0ciA9IHZlcnMuc3Vic3RyaW5nKHZlcnMuaW5kZXhPZihcIi9cIikgKyAxLCBkb3QpO1xuICAgICAgY29uc3QgbWFqb3IgPSBOdW1iZXIobWFqb3JTdHIpO1xuICAgICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1ham9yKSB8fCBtYWpvciA8IDAgfHwgbWFqb3IgPiBCaWcpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1pbm9yU3RyID0gdmVycy5zdWJzdHJpbmcoZG90ICsgMSk7XG4gICAgICBjb25zdCBtaW5vciA9IE51bWJlcihtaW5vclN0cik7XG4gICAgICBpZiAoIU51bWJlci5pc0ludGVnZXIobWlub3IpIHx8IG1pbm9yIDwgMCB8fCBtaW5vciA+IEJpZykge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIFttYWpvciwgbWlub3JdO1xuICAgIH1cbiAgfVxuXG4gIHRocm93IG5ldyBFcnJvcihgbWFsZm9ybWVkIEhUVFAgdmVyc2lvbiAke3ZlcnN9YCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkUmVxdWVzdChcbiAgY29ubjogRGVuby5Db25uLFxuICBidWZyOiBCdWZSZWFkZXIsXG4pOiBQcm9taXNlPFNlcnZlclJlcXVlc3QgfCBudWxsPiB7XG4gIGNvbnN0IHRwID0gbmV3IFRleHRQcm90b1JlYWRlcihidWZyKTtcbiAgY29uc3QgZmlyc3RMaW5lID0gYXdhaXQgdHAucmVhZExpbmUoKTsgLy8gZS5nLiBHRVQgL2luZGV4Lmh0bWwgSFRUUC8xLjBcbiAgaWYgKGZpcnN0TGluZSA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhlYWRlcnMgPSBhd2FpdCB0cC5yZWFkTUlNRUhlYWRlcigpO1xuICBpZiAoaGVhZGVycyA9PT0gbnVsbCkgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcblxuICBjb25zdCByZXEgPSBuZXcgU2VydmVyUmVxdWVzdCgpO1xuICByZXEuY29ubiA9IGNvbm47XG4gIHJlcS5yID0gYnVmcjtcbiAgW3JlcS5tZXRob2QsIHJlcS51cmwsIHJlcS5wcm90b10gPSBmaXJzdExpbmUuc3BsaXQoXCIgXCIsIDMpO1xuICBbcmVxLnByb3RvTWlub3IsIHJlcS5wcm90b01ham9yXSA9IHBhcnNlSFRUUFZlcnNpb24ocmVxLnByb3RvKTtcbiAgcmVxLmhlYWRlcnMgPSBoZWFkZXJzO1xuICBmaXhMZW5ndGgocmVxKTtcbiAgcmV0dXJuIHJlcTtcbn1cblxuZnVuY3Rpb24gZml4TGVuZ3RoKHJlcTogU2VydmVyUmVxdWVzdCk6IHZvaWQge1xuICBjb25zdCBjb250ZW50TGVuZ3RoID0gcmVxLmhlYWRlcnMuZ2V0KFwiQ29udGVudC1MZW5ndGhcIik7XG4gIGlmIChjb250ZW50TGVuZ3RoKSB7XG4gICAgY29uc3QgYXJyQ2xlbiA9IGNvbnRlbnRMZW5ndGguc3BsaXQoXCIsXCIpO1xuICAgIGlmIChhcnJDbGVuLmxlbmd0aCA+IDEpIHtcbiAgICAgIGNvbnN0IGRpc3RpbmN0ID0gWy4uLm5ldyBTZXQoYXJyQ2xlbi5tYXAoKGUpOiBzdHJpbmcgPT4gZS50cmltKCkpKV07XG4gICAgICBpZiAoZGlzdGluY3QubGVuZ3RoID4gMSkge1xuICAgICAgICB0aHJvdyBFcnJvcihcImNhbm5vdCBjb250YWluIG11bHRpcGxlIENvbnRlbnQtTGVuZ3RoIGhlYWRlcnNcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXEuaGVhZGVycy5zZXQoXCJDb250ZW50LUxlbmd0aFwiLCBkaXN0aW5jdFswXSk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGMgPSByZXEuaGVhZGVycy5nZXQoXCJDb250ZW50LUxlbmd0aFwiKTtcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJIRUFEXCIgJiYgYyAmJiBjICE9PSBcIjBcIikge1xuICAgICAgdGhyb3cgRXJyb3IoXCJodHRwOiBtZXRob2QgY2Fubm90IGNvbnRhaW4gYSBDb250ZW50LUxlbmd0aFwiKTtcbiAgICB9XG4gICAgaWYgKGMgJiYgcmVxLmhlYWRlcnMuaGFzKFwidHJhbnNmZXItZW5jb2RpbmdcIikpIHtcbiAgICAgIC8vIEEgc2VuZGVyIE1VU1QgTk9UIHNlbmQgYSBDb250ZW50LUxlbmd0aCBoZWFkZXIgZmllbGQgaW4gYW55IG1lc3NhZ2VcbiAgICAgIC8vIHRoYXQgY29udGFpbnMgYSBUcmFuc2Zlci1FbmNvZGluZyBoZWFkZXIgZmllbGQuXG4gICAgICAvLyByZmM6IGh0dHBzOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9yZmM3MjMwI3NlY3Rpb24tMy4zLjJcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJodHRwOiBUcmFuc2Zlci1FbmNvZGluZyBhbmQgQ29udGVudC1MZW5ndGggY2Fubm90IGJlIHNlbmQgdG9nZXRoZXJcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsMEVBQTBFO0FBQzFFLFNBQW9CLFNBQVMsUUFBUSxpQkFBaUI7QUFDdEQsU0FBUyxlQUFlLFFBQVEsc0JBQXNCO0FBQ3RELFNBQVMsTUFBTSxRQUFRLHFCQUFxQjtBQUM1QyxTQUFTLE9BQU8sUUFBUSxzQkFBc0I7QUFDOUMsU0FBbUIsYUFBYSxRQUFRLGNBQWM7QUFDdEQsU0FBUyxXQUFXLFFBQVEsbUJBQW1CO0FBRS9DLE9BQU8sU0FBUyxjQUEyQjtJQUN6QyxPQUFPO1FBQ0wsTUFBSyxDQUFhLEVBQTBCO1lBQzFDLE9BQU8sUUFBUSxPQUFPLENBQUMsSUFBSTtRQUM3QjtJQUNGO0FBQ0YsQ0FBQztBQUVELE9BQU8sU0FBUyxXQUFXLGFBQXFCLEVBQUUsQ0FBWSxFQUFlO0lBQzNFLElBQUksWUFBWTtJQUNoQixJQUFJLFdBQVcsS0FBSztJQUNwQixlQUFlLEtBQUss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