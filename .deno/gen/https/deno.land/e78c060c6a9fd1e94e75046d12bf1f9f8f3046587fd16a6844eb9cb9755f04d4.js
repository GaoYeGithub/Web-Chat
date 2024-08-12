// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
import { decode, encode } from "../encoding/utf8.ts";
import { hasOwnProperty } from "../_util/has_own_property.ts";
import { BufReader, BufWriter } from "../io/bufio.ts";
import { readLong, readShort, sliceLongToBytes } from "../io/ioutil.ts";
import { Sha1 } from "../hash/sha1.ts";
import { writeResponse } from "../http/_io.ts";
import { TextProtoReader } from "../textproto/mod.ts";
import { deferred } from "../async/deferred.ts";
import { assert } from "../_util/assert.ts";
import { concat } from "../bytes/mod.ts";
export var OpCode;
(function(OpCode) {
    OpCode[OpCode["Continue"] = 0x0] = "Continue";
    OpCode[OpCode["TextFrame"] = 0x1] = "TextFrame";
    OpCode[OpCode["BinaryFrame"] = 0x2] = "BinaryFrame";
    OpCode[OpCode["Close"] = 0x8] = "Close";
    OpCode[OpCode["Ping"] = 0x9] = "Ping";
    OpCode[OpCode["Pong"] = 0xa] = "Pong";
})(OpCode || (OpCode = {}));
export function isWebSocketCloseEvent(a) {
    return hasOwnProperty(a, "code");
}
export function isWebSocketPingEvent(a) {
    return Array.isArray(a) && a[0] === "ping" && a[1] instanceof Uint8Array;
}
export function isWebSocketPongEvent(a) {
    return Array.isArray(a) && a[0] === "pong" && a[1] instanceof Uint8Array;
}
/** Unmask masked websocket payload */ export function unmask(payload, mask) {
    if (mask) {
        for(let i = 0, len = payload.length; i < len; i++){
            payload[i] ^= mask[i & 3];
        }
    }
}
/** Write websocket frame to given writer */ export async function writeFrame(frame, writer) {
    const payloadLength = frame.payload.byteLength;
    let header;
    const hasMask = frame.mask ? 0x80 : 0;
    if (frame.mask && frame.mask.byteLength !== 4) {
        throw new Error("invalid mask. mask must be 4 bytes: length=" + frame.mask.byteLength);
    }
    if (payloadLength < 126) {
        header = new Uint8Array([
            0x80 | frame.opcode,
            hasMask | payloadLength
        ]);
    } else if (payloadLength < 0xffff) {
        header = new Uint8Array([
            0x80 | frame.opcode,
            hasMask | 0b01111110,
            payloadLength >>> 8,
            payloadLength & 0x00ff
        ]);
    } else {
        header = new Uint8Array([
            0x80 | frame.opcode,
            hasMask | 0b01111111,
            ...sliceLongToBytes(payloadLength)
        ]);
    }
    if (frame.mask) {
        header = concat(header, frame.mask);
    }
    unmask(frame.payload, frame.mask);
    header = concat(header, frame.payload);
    const w = BufWriter.create(writer);
    await w.write(header);
    await w.flush();
}
/** Read websocket frame from given BufReader
 * @throws `Deno.errors.UnexpectedEof` When peer closed connection without close frame
 * @throws `Error` Frame is invalid
 */ export async function readFrame(buf) {
    let b = await buf.readByte();
    assert(b !== null);
    let isLastFrame = false;
    switch(b >>> 4){
        case 0b1000:
            isLastFrame = true;
            break;
        case 0b0000:
            isLastFrame = false;
            break;
        default:
            throw new Error("invalid signature");
    }
    const opcode = b & 0x0f;
    // has_mask & payload
    b = await buf.readByte();
    assert(b !== null);
    const hasMask = b >>> 7;
    let payloadLength = b & 0b01111111;
    if (payloadLength === 126) {
        const l = await readShort(buf);
        assert(l !== null);
        payloadLength = l;
    } else if (payloadLength === 127) {
        const l = await readLong(buf);
        assert(l !== null);
        payloadLength = Number(l);
    }
    // mask
    let mask;
    if (hasMask) {
        mask = new Uint8Array(4);
        assert(await buf.readFull(mask) !== null);
    }
    // payload
    const payload = new Uint8Array(payloadLength);
    assert(await buf.readFull(payload) !== null);
    return {
        isLastFrame,
        opcode,
        mask,
        payload
    };
}
class WebSocketImpl {
    conn;
    mask;
    bufReader;
    bufWriter;
    sendQueue = [];
    constructor({ conn , bufReader , bufWriter , mask  }){
        this.conn = conn;
        this.mask = mask;
        this.bufReader = bufReader || new BufReader(conn);
        this.bufWriter = bufWriter || new BufWriter(conn);
    }
    async *[Symbol.asyncIterator]() {
        let frames = [];
        let payloadsLength = 0;
        while(!this._isClosed){
            let frame;
            try {
                frame = await readFrame(this.bufReader);
            } catch (e) {
                this.ensureSocketClosed();
                break;
            }
            unmask(frame.payload, frame.mask);
            switch(frame.opcode){
                case OpCode.TextFrame:
                case OpCode.BinaryFrame:
                case OpCode.Continue:
                    frames.push(frame);
                    payloadsLength += frame.payload.length;
                    if (frame.isLastFrame) {
                        const concat = new Uint8Array(payloadsLength);
                        let offs = 0;
                        for (const frame of frames){
                            concat.set(frame.payload, offs);
                            offs += frame.payload.length;
                        }
                        if (frames[0].opcode === OpCode.TextFrame) {
                            // text
                            yield decode(concat);
                        } else {
                            // binary
                            yield concat;
                        }
                        frames = [];
                        payloadsLength = 0;
                    }
                    break;
                case OpCode.Close:
                    {
                        // [0x12, 0x34] -> 0x1234
                        const code = frame.payload[0] << 8 | frame.payload[1];
                        const reason = decode(frame.payload.subarray(2, frame.payload.length));
                        await this.close(code, reason);
                        yield {
                            code,
                            reason
                        };
                        return;
                    }
                case OpCode.Ping:
                    await this.enqueue({
                        opcode: OpCode.Pong,
                        payload: frame.payload,
                        isLastFrame: true
                    });
                    yield [
                        "ping",
                        frame.payload
                    ];
                    break;
                case OpCode.Pong:
                    yield [
                        "pong",
                        frame.payload
                    ];
                    break;
                default:
            }
        }
    }
    dequeue() {
        const [entry] = this.sendQueue;
        if (!entry) return;
        if (this._isClosed) return;
        const { d , frame  } = entry;
        writeFrame(frame, this.bufWriter).then(()=>d.resolve()).catch((e)=>d.reject(e)).finally(()=>{
            this.sendQueue.shift();
            this.dequeue();
        });
    }
    enqueue(frame) {
        if (this._isClosed) {
            throw new Deno.errors.ConnectionReset("Socket has already been closed");
        }
        const d = deferred();
        this.sendQueue.push({
            d,
            frame
        });
        if (this.sendQueue.length === 1) {
            this.dequeue();
        }
        return d;
    }
    send(data) {
        const opcode = typeof data === "string" ? OpCode.TextFrame : OpCode.BinaryFrame;
        const payload = typeof data === "string" ? encode(data) : data;
        const isLastFrame = true;
        const frame = {
            isLastFrame,
            opcode,
            payload,
            mask: this.mask
        };
        return this.enqueue(frame);
    }
    ping(data = "") {
        const payload = typeof data === "string" ? encode(data) : data;
        const frame = {
            isLastFrame: true,
            opcode: OpCode.Ping,
            mask: this.mask,
            payload
        };
        return this.enqueue(frame);
    }
    _isClosed = false;
    get isClosed() {
        return this._isClosed;
    }
    async close(code = 1000, reason) {
        try {
            const header = [
                code >>> 8,
                code & 0x00ff
            ];
            let payload;
            if (reason) {
                const reasonBytes = encode(reason);
                payload = new Uint8Array(2 + reasonBytes.byteLength);
                payload.set(header);
                payload.set(reasonBytes, 2);
            } else {
                payload = new Uint8Array(header);
            }
            await this.enqueue({
                isLastFrame: true,
                opcode: OpCode.Close,
                mask: this.mask,
                payload
            });
        } catch (e) {
            throw e;
        } finally{
            this.ensureSocketClosed();
        }
    }
    closeForce() {
        this.ensureSocketClosed();
    }
    ensureSocketClosed() {
        if (this.isClosed) return;
        try {
            this.conn.close();
        } catch (e) {
            console.error(e);
        } finally{
            this._isClosed = true;
            const rest = this.sendQueue;
            this.sendQueue = [];
            rest.forEach((e)=>e.d.reject(new Deno.errors.ConnectionReset("Socket has already been closed")));
        }
    }
}
/** Return whether given headers is acceptable for websocket  */ export function acceptable(req) {
    const upgrade = req.headers.get("upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return false;
    }
    const secKey = req.headers.get("sec-websocket-key");
    return req.headers.has("sec-websocket-key") && typeof secKey === "string" && secKey.length > 0;
}
const kGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Create sec-websocket-accept header value with given nonce */ export function createSecAccept(nonce) {
    const sha1 = new Sha1();
    sha1.update(nonce + kGUID);
    const bytes = sha1.digest();
    return btoa(String.fromCharCode(...bytes));
}
/** Upgrade given TCP connection into websocket connection */ export async function acceptWebSocket(req) {
    const { conn , headers , bufReader , bufWriter  } = req;
    if (acceptable(req)) {
        const sock = new WebSocketImpl({
            conn,
            bufReader,
            bufWriter
        });
        const secKey = headers.get("sec-websocket-key");
        if (typeof secKey !== "string") {
            throw new Error("sec-websocket-key is not provided");
        }
        const secAccept = createSecAccept(secKey);
        await writeResponse(bufWriter, {
            status: 101,
            headers: new Headers({
                Upgrade: "websocket",
                Connection: "Upgrade",
                "Sec-WebSocket-Accept": secAccept
            })
        });
        return sock;
    }
    throw new Error("request is not acceptable");
}
const kSecChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-.~_";
/** Create WebSocket-Sec-Key. Base64 encoded 16 bytes string */ export function createSecKey() {
    let key = "";
    for(let i = 0; i < 16; i++){
        const j = Math.floor(Math.random() * kSecChars.length);
        key += kSecChars[j];
    }
    return btoa(key);
}
export async function handshake(url, headers, bufReader, bufWriter) {
    const { hostname , pathname , search  } = url;
    const key = createSecKey();
    if (!headers.has("host")) {
        headers.set("host", hostname);
    }
    headers.set("upgrade", "websocket");
    headers.set("connection", "upgrade");
    headers.set("sec-websocket-key", key);
    headers.set("sec-websocket-version", "13");
    let headerStr = `GET ${pathname}${search} HTTP/1.1\r\n`;
    for (const [key, value] of headers){
        headerStr += `${key}: ${value}\r\n`;
    }
    headerStr += "\r\n";
    await bufWriter.write(encode(headerStr));
    await bufWriter.flush();
    const tpReader = new TextProtoReader(bufReader);
    const statusLine = await tpReader.readLine();
    if (statusLine === null) {
        throw new Deno.errors.UnexpectedEof();
    }
    const m = statusLine.match(/^(?<version>\S+) (?<statusCode>\S+) /);
    if (!m) {
        throw new Error("ws: invalid status line: " + statusLine);
    }
    assert(m.groups);
    const { version , statusCode  } = m.groups;
    if (version !== "HTTP/1.1" || statusCode !== "101") {
        throw new Error(`ws: server didn't accept handshake: ` + `version=${version}, statusCode=${statusCode}`);
    }
    const responseHeaders = await tpReader.readMIMEHeader();
    if (responseHeaders === null) {
        throw new Deno.errors.UnexpectedEof();
    }
    const expectedSecAccept = createSecAccept(key);
    const secAccept = responseHeaders.get("sec-websocket-accept");
    if (secAccept !== expectedSecAccept) {
        throw new Error(`ws: unexpected sec-websocket-accept header: ` + `expected=${expectedSecAccept}, actual=${secAccept}`);
    }
}
export function createWebSocket(params) {
    return new WebSocketImpl(params);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvd3MvbW9kLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjAgdGhlIERlbm8gYXV0aG9ycy4gQWxsIHJpZ2h0cyByZXNlcnZlZC4gTUlUIGxpY2Vuc2UuXG5pbXBvcnQgeyBkZWNvZGUsIGVuY29kZSB9IGZyb20gXCIuLi9lbmNvZGluZy91dGY4LnRzXCI7XG5pbXBvcnQgeyBoYXNPd25Qcm9wZXJ0eSB9IGZyb20gXCIuLi9fdXRpbC9oYXNfb3duX3Byb3BlcnR5LnRzXCI7XG5pbXBvcnQgeyBCdWZSZWFkZXIsIEJ1ZldyaXRlciB9IGZyb20gXCIuLi9pby9idWZpby50c1wiO1xuaW1wb3J0IHsgcmVhZExvbmcsIHJlYWRTaG9ydCwgc2xpY2VMb25nVG9CeXRlcyB9IGZyb20gXCIuLi9pby9pb3V0aWwudHNcIjtcbmltcG9ydCB7IFNoYTEgfSBmcm9tIFwiLi4vaGFzaC9zaGExLnRzXCI7XG5pbXBvcnQgeyB3cml0ZVJlc3BvbnNlIH0gZnJvbSBcIi4uL2h0dHAvX2lvLnRzXCI7XG5pbXBvcnQgeyBUZXh0UHJvdG9SZWFkZXIgfSBmcm9tIFwiLi4vdGV4dHByb3RvL21vZC50c1wiO1xuaW1wb3J0IHsgRGVmZXJyZWQsIGRlZmVycmVkIH0gZnJvbSBcIi4uL2FzeW5jL2RlZmVycmVkLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnQgfSBmcm9tIFwiLi4vX3V0aWwvYXNzZXJ0LnRzXCI7XG5pbXBvcnQgeyBjb25jYXQgfSBmcm9tIFwiLi4vYnl0ZXMvbW9kLnRzXCI7XG5cbmV4cG9ydCBlbnVtIE9wQ29kZSB7XG4gIENvbnRpbnVlID0gMHgwLFxuICBUZXh0RnJhbWUgPSAweDEsXG4gIEJpbmFyeUZyYW1lID0gMHgyLFxuICBDbG9zZSA9IDB4OCxcbiAgUGluZyA9IDB4OSxcbiAgUG9uZyA9IDB4YSxcbn1cblxuZXhwb3J0IHR5cGUgV2ViU29ja2V0RXZlbnQgPVxuICB8IHN0cmluZ1xuICB8IFVpbnQ4QXJyYXlcbiAgfCBXZWJTb2NrZXRDbG9zZUV2ZW50IC8vIFJlY2VpdmVkIGFmdGVyIGNsb3NpbmcgY29ubmVjdGlvbiBmaW5pc2hlZC5cbiAgfCBXZWJTb2NrZXRQaW5nRXZlbnQgLy8gUmVjZWl2ZWQgYWZ0ZXIgcG9uZyBmcmFtZSByZXNwb25kZWQuXG4gIHwgV2ViU29ja2V0UG9uZ0V2ZW50O1xuXG5leHBvcnQgaW50ZXJmYWNlIFdlYlNvY2tldENsb3NlRXZlbnQge1xuICBjb2RlOiBudW1iZXI7XG4gIHJlYXNvbj86IHN0cmluZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzV2ViU29ja2V0Q2xvc2VFdmVudChcbiAgYTogV2ViU29ja2V0RXZlbnQsXG4pOiBhIGlzIFdlYlNvY2tldENsb3NlRXZlbnQge1xuICByZXR1cm4gaGFzT3duUHJvcGVydHkoYSwgXCJjb2RlXCIpO1xufVxuXG5leHBvcnQgdHlwZSBXZWJTb2NrZXRQaW5nRXZlbnQgPSBbXCJwaW5nXCIsIFVpbnQ4QXJyYXldO1xuXG5leHBvcnQgZnVuY3Rpb24gaXNXZWJTb2NrZXRQaW5nRXZlbnQoXG4gIGE6IFdlYlNvY2tldEV2ZW50LFxuKTogYSBpcyBXZWJTb2NrZXRQaW5nRXZlbnQge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShhKSAmJiBhWzBdID09PSBcInBpbmdcIiAmJiBhWzFdIGluc3RhbmNlb2YgVWludDhBcnJheTtcbn1cblxuZXhwb3J0IHR5cGUgV2ViU29ja2V0UG9uZ0V2ZW50ID0gW1wicG9uZ1wiLCBVaW50OEFycmF5XTtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzV2ViU29ja2V0UG9uZ0V2ZW50KFxuICBhOiBXZWJTb2NrZXRFdmVudCxcbik6IGEgaXMgV2ViU29ja2V0UG9uZ0V2ZW50IHtcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkoYSkgJiYgYVswXSA9PT0gXCJwb25nXCIgJiYgYVsxXSBpbnN0YW5jZW9mIFVpbnQ4QXJyYXk7XG59XG5cbmV4cG9ydCB0eXBlIFdlYlNvY2tldE1lc3NhZ2UgPSBzdHJpbmcgfCBVaW50OEFycmF5O1xuXG5leHBvcnQgaW50ZXJmYWNlIFdlYlNvY2tldEZyYW1lIHtcbiAgaXNMYXN0RnJhbWU6IGJvb2xlYW47XG4gIG9wY29kZTogT3BDb2RlO1xuICBtYXNrPzogVWludDhBcnJheTtcbiAgcGF5bG9hZDogVWludDhBcnJheTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXZWJTb2NrZXQgZXh0ZW5kcyBBc3luY0l0ZXJhYmxlPFdlYlNvY2tldEV2ZW50PiB7XG4gIHJlYWRvbmx5IGNvbm46IERlbm8uQ29ubjtcbiAgcmVhZG9ubHkgaXNDbG9zZWQ6IGJvb2xlYW47XG5cbiAgW1N5bWJvbC5hc3luY0l0ZXJhdG9yXSgpOiBBc3luY0l0ZXJhYmxlSXRlcmF0b3I8V2ViU29ja2V0RXZlbnQ+O1xuXG4gIC8qKlxuICAgKiBAdGhyb3dzIGBEZW5vLmVycm9ycy5Db25uZWN0aW9uUmVzZXRgXG4gICAqL1xuICBzZW5kKGRhdGE6IFdlYlNvY2tldE1lc3NhZ2UpOiBQcm9taXNlPHZvaWQ+O1xuXG4gIC8qKlxuICAgKiBAcGFyYW0gZGF0YVxuICAgKiBAdGhyb3dzIGBEZW5vLmVycm9ycy5Db25uZWN0aW9uUmVzZXRgXG4gICAqL1xuICBwaW5nKGRhdGE/OiBXZWJTb2NrZXRNZXNzYWdlKTogUHJvbWlzZTx2b2lkPjtcblxuICAvKiogQ2xvc2UgY29ubmVjdGlvbiBhZnRlciBzZW5kaW5nIGNsb3NlIGZyYW1lIHRvIHBlZXIuXG4gICAqIFRoaXMgaXMgY2Fub25pY2FsIHdheSBvZiBkaXNjb25uZWN0aW9uIGJ1dCBpdCBtYXkgaGFuZyBiZWNhdXNlIG9mIHBlZXIncyByZXNwb25zZSBkZWxheS5cbiAgICogRGVmYXVsdCBjbG9zZSBjb2RlIGlzIDEwMDAgKE5vcm1hbCBDbG9zdXJlKVxuICAgKiBAdGhyb3dzIGBEZW5vLmVycm9ycy5Db25uZWN0aW9uUmVzZXRgXG4gICAqL1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xuICBjbG9zZShjb2RlOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+O1xuICBjbG9zZShjb2RlOiBudW1iZXIsIHJlYXNvbjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPjtcblxuICAvKiogQ2xvc2UgY29ubmVjdGlvbiBmb3JjZWx5IHdpdGhvdXQgc2VuZGluZyBjbG9zZSBmcmFtZSB0byBwZWVyLlxuICAgKiAgVGhpcyBpcyBiYXNpY2FsbHkgdW5kZXNpcmFibGUgd2F5IG9mIGRpc2Nvbm5lY3Rpb24uIFVzZSBjYXJlZnVsbHkuICovXG4gIGNsb3NlRm9yY2UoKTogdm9pZDtcbn1cblxuLyoqIFVubWFzayBtYXNrZWQgd2Vic29ja2V0IHBheWxvYWQgKi9cbmV4cG9ydCBmdW5jdGlvbiB1bm1hc2socGF5bG9hZDogVWludDhBcnJheSwgbWFzaz86IFVpbnQ4QXJyYXkpOiB2b2lkIHtcbiAgaWYgKG1hc2spIHtcbiAgICBmb3IgKGxldCBpID0gMCwgbGVuID0gcGF5bG9hZC5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgICAgcGF5bG9hZFtpXSBePSBtYXNrW2kgJiAzXTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIFdyaXRlIHdlYnNvY2tldCBmcmFtZSB0byBnaXZlbiB3cml0ZXIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3cml0ZUZyYW1lKFxuICBmcmFtZTogV2ViU29ja2V0RnJhbWUsXG4gIHdyaXRlcjogRGVuby5Xcml0ZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcGF5bG9hZExlbmd0aCA9IGZyYW1lLnBheWxvYWQuYnl0ZUxlbmd0aDtcbiAgbGV0IGhlYWRlcjogVWludDhBcnJheTtcbiAgY29uc3QgaGFzTWFzayA9IGZyYW1lLm1hc2sgPyAweDgwIDogMDtcbiAgaWYgKGZyYW1lLm1hc2sgJiYgZnJhbWUubWFzay5ieXRlTGVuZ3RoICE9PSA0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJpbnZhbGlkIG1hc2suIG1hc2sgbXVzdCBiZSA0IGJ5dGVzOiBsZW5ndGg9XCIgKyBmcmFtZS5tYXNrLmJ5dGVMZW5ndGgsXG4gICAgKTtcbiAgfVxuICBpZiAocGF5bG9hZExlbmd0aCA8IDEyNikge1xuICAgIGhlYWRlciA9IG5ldyBVaW50OEFycmF5KFsweDgwIHwgZnJhbWUub3Bjb2RlLCBoYXNNYXNrIHwgcGF5bG9hZExlbmd0aF0pO1xuICB9IGVsc2UgaWYgKHBheWxvYWRMZW5ndGggPCAweGZmZmYpIHtcbiAgICBoZWFkZXIgPSBuZXcgVWludDhBcnJheShbXG4gICAgICAweDgwIHwgZnJhbWUub3Bjb2RlLFxuICAgICAgaGFzTWFzayB8IDBiMDExMTExMTAsXG4gICAgICBwYXlsb2FkTGVuZ3RoID4+PiA4LFxuICAgICAgcGF5bG9hZExlbmd0aCAmIDB4MDBmZixcbiAgICBdKTtcbiAgfSBlbHNlIHtcbiAgICBoZWFkZXIgPSBuZXcgVWludDhBcnJheShbXG4gICAgICAweDgwIHwgZnJhbWUub3Bjb2RlLFxuICAgICAgaGFzTWFzayB8IDBiMDExMTExMTEsXG4gICAgICAuLi5zbGljZUxvbmdUb0J5dGVzKHBheWxvYWRMZW5ndGgpLFxuICAgIF0pO1xuICB9XG4gIGlmIChmcmFtZS5tYXNrKSB7XG4gICAgaGVhZGVyID0gY29uY2F0KGhlYWRlciwgZnJhbWUubWFzayk7XG4gIH1cbiAgdW5tYXNrKGZyYW1lLnBheWxvYWQsIGZyYW1lLm1hc2spO1xuICBoZWFkZXIgPSBjb25jYXQoaGVhZGVyLCBmcmFtZS5wYXlsb2FkKTtcbiAgY29uc3QgdyA9IEJ1ZldyaXRlci5jcmVhdGUod3JpdGVyKTtcbiAgYXdhaXQgdy53cml0ZShoZWFkZXIpO1xuICBhd2FpdCB3LmZsdXNoKCk7XG59XG5cbi8qKiBSZWFkIHdlYnNvY2tldCBmcmFtZSBmcm9tIGdpdmVuIEJ1ZlJlYWRlclxuICogQHRocm93cyBgRGVuby5lcnJvcnMuVW5leHBlY3RlZEVvZmAgV2hlbiBwZWVyIGNsb3NlZCBjb25uZWN0aW9uIHdpdGhvdXQgY2xvc2UgZnJhbWVcbiAqIEB0aHJvd3MgYEVycm9yYCBGcmFtZSBpcyBpbnZhbGlkXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkRnJhbWUoYnVmOiBCdWZSZWFkZXIpOiBQcm9taXNlPFdlYlNvY2tldEZyYW1lPiB7XG4gIGxldCBiID0gYXdhaXQgYnVmLnJlYWRCeXRlKCk7XG4gIGFzc2VydChiICE9PSBudWxsKTtcbiAgbGV0IGlzTGFzdEZyYW1lID0gZmFsc2U7XG4gIHN3aXRjaCAoYiA+Pj4gNCkge1xuICAgIGNhc2UgMGIxMDAwOlxuICAgICAgaXNMYXN0RnJhbWUgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAwYjAwMDA6XG4gICAgICBpc0xhc3RGcmFtZSA9IGZhbHNlO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImludmFsaWQgc2lnbmF0dXJlXCIpO1xuICB9XG4gIGNvbnN0IG9wY29kZSA9IGIgJiAweDBmO1xuICAvLyBoYXNfbWFzayAmIHBheWxvYWRcbiAgYiA9IGF3YWl0IGJ1Zi5yZWFkQnl0ZSgpO1xuICBhc3NlcnQoYiAhPT0gbnVsbCk7XG4gIGNvbnN0IGhhc01hc2sgPSBiID4+PiA3O1xuICBsZXQgcGF5bG9hZExlbmd0aCA9IGIgJiAwYjAxMTExMTExO1xuICBpZiAocGF5bG9hZExlbmd0aCA9PT0gMTI2KSB7XG4gICAgY29uc3QgbCA9IGF3YWl0IHJlYWRTaG9ydChidWYpO1xuICAgIGFzc2VydChsICE9PSBudWxsKTtcbiAgICBwYXlsb2FkTGVuZ3RoID0gbDtcbiAgfSBlbHNlIGlmIChwYXlsb2FkTGVuZ3RoID09PSAxMjcpIHtcbiAgICBjb25zdCBsID0gYXdhaXQgcmVhZExvbmcoYnVmKTtcbiAgICBhc3NlcnQobCAhPT0gbnVsbCk7XG4gICAgcGF5bG9hZExlbmd0aCA9IE51bWJlcihsKTtcbiAgfVxuICAvLyBtYXNrXG4gIGxldCBtYXNrOiBVaW50OEFycmF5IHwgdW5kZWZpbmVkO1xuICBpZiAoaGFzTWFzaykge1xuICAgIG1hc2sgPSBuZXcgVWludDhBcnJheSg0KTtcbiAgICBhc3NlcnQoKGF3YWl0IGJ1Zi5yZWFkRnVsbChtYXNrKSkgIT09IG51bGwpO1xuICB9XG4gIC8vIHBheWxvYWRcbiAgY29uc3QgcGF5bG9hZCA9IG5ldyBVaW50OEFycmF5KHBheWxvYWRMZW5ndGgpO1xuICBhc3NlcnQoKGF3YWl0IGJ1Zi5yZWFkRnVsbChwYXlsb2FkKSkgIT09IG51bGwpO1xuICByZXR1cm4ge1xuICAgIGlzTGFzdEZyYW1lLFxuICAgIG9wY29kZSxcbiAgICBtYXNrLFxuICAgIHBheWxvYWQsXG4gIH07XG59XG5cbmNsYXNzIFdlYlNvY2tldEltcGwgaW1wbGVtZW50cyBXZWJTb2NrZXQge1xuICByZWFkb25seSBjb25uOiBEZW5vLkNvbm47XG4gIHByaXZhdGUgcmVhZG9ubHkgbWFzaz86IFVpbnQ4QXJyYXk7XG4gIHByaXZhdGUgcmVhZG9ubHkgYnVmUmVhZGVyOiBCdWZSZWFkZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgYnVmV3JpdGVyOiBCdWZXcml0ZXI7XG4gIHByaXZhdGUgc2VuZFF1ZXVlOiBBcnJheTx7XG4gICAgZnJhbWU6IFdlYlNvY2tldEZyYW1lO1xuICAgIGQ6IERlZmVycmVkPHZvaWQ+O1xuICB9PiA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKHtcbiAgICBjb25uLFxuICAgIGJ1ZlJlYWRlcixcbiAgICBidWZXcml0ZXIsXG4gICAgbWFzayxcbiAgfToge1xuICAgIGNvbm46IERlbm8uQ29ubjtcbiAgICBidWZSZWFkZXI/OiBCdWZSZWFkZXI7XG4gICAgYnVmV3JpdGVyPzogQnVmV3JpdGVyO1xuICAgIG1hc2s/OiBVaW50OEFycmF5O1xuICB9KSB7XG4gICAgdGhpcy5jb25uID0gY29ubjtcbiAgICB0aGlzLm1hc2sgPSBtYXNrO1xuICAgIHRoaXMuYnVmUmVhZGVyID0gYnVmUmVhZGVyIHx8IG5ldyBCdWZSZWFkZXIoY29ubik7XG4gICAgdGhpcy5idWZXcml0ZXIgPSBidWZXcml0ZXIgfHwgbmV3IEJ1ZldyaXRlcihjb25uKTtcbiAgfVxuXG4gIGFzeW5jICpbU3ltYm9sLmFzeW5jSXRlcmF0b3JdKCk6IEFzeW5jSXRlcmFibGVJdGVyYXRvcjxXZWJTb2NrZXRFdmVudD4ge1xuICAgIGxldCBmcmFtZXM6IFdlYlNvY2tldEZyYW1lW10gPSBbXTtcbiAgICBsZXQgcGF5bG9hZHNMZW5ndGggPSAwO1xuICAgIHdoaWxlICghdGhpcy5faXNDbG9zZWQpIHtcbiAgICAgIGxldCBmcmFtZTogV2ViU29ja2V0RnJhbWU7XG4gICAgICB0cnkge1xuICAgICAgICBmcmFtZSA9IGF3YWl0IHJlYWRGcmFtZSh0aGlzLmJ1ZlJlYWRlcik7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRoaXMuZW5zdXJlU29ja2V0Q2xvc2VkKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgdW5tYXNrKGZyYW1lLnBheWxvYWQsIGZyYW1lLm1hc2spO1xuICAgICAgc3dpdGNoIChmcmFtZS5vcGNvZGUpIHtcbiAgICAgICAgY2FzZSBPcENvZGUuVGV4dEZyYW1lOlxuICAgICAgICBjYXNlIE9wQ29kZS5CaW5hcnlGcmFtZTpcbiAgICAgICAgY2FzZSBPcENvZGUuQ29udGludWU6XG4gICAgICAgICAgZnJhbWVzLnB1c2goZnJhbWUpO1xuICAgICAgICAgIHBheWxvYWRzTGVuZ3RoICs9IGZyYW1lLnBheWxvYWQubGVuZ3RoO1xuICAgICAgICAgIGlmIChmcmFtZS5pc0xhc3RGcmFtZSkge1xuICAgICAgICAgICAgY29uc3QgY29uY2F0ID0gbmV3IFVpbnQ4QXJyYXkocGF5bG9hZHNMZW5ndGgpO1xuICAgICAgICAgICAgbGV0IG9mZnMgPSAwO1xuICAgICAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBmcmFtZXMpIHtcbiAgICAgICAgICAgICAgY29uY2F0LnNldChmcmFtZS5wYXlsb2FkLCBvZmZzKTtcbiAgICAgICAgICAgICAgb2ZmcyArPSBmcmFtZS5wYXlsb2FkLmxlbmd0aDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChmcmFtZXNbMF0ub3Bjb2RlID09PSBPcENvZGUuVGV4dEZyYW1lKSB7XG4gICAgICAgICAgICAgIC8vIHRleHRcbiAgICAgICAgICAgICAgeWllbGQgZGVjb2RlKGNvbmNhdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBiaW5hcnlcbiAgICAgICAgICAgICAgeWllbGQgY29uY2F0O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZnJhbWVzID0gW107XG4gICAgICAgICAgICBwYXlsb2Fkc0xlbmd0aCA9IDA7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIE9wQ29kZS5DbG9zZToge1xuICAgICAgICAgIC8vIFsweDEyLCAweDM0XSAtPiAweDEyMzRcbiAgICAgICAgICBjb25zdCBjb2RlID0gKGZyYW1lLnBheWxvYWRbMF0gPDwgOCkgfCBmcmFtZS5wYXlsb2FkWzFdO1xuICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGRlY29kZShcbiAgICAgICAgICAgIGZyYW1lLnBheWxvYWQuc3ViYXJyYXkoMiwgZnJhbWUucGF5bG9hZC5sZW5ndGgpLFxuICAgICAgICAgICk7XG4gICAgICAgICAgYXdhaXQgdGhpcy5jbG9zZShjb2RlLCByZWFzb24pO1xuICAgICAgICAgIHlpZWxkIHsgY29kZSwgcmVhc29uIH07XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNhc2UgT3BDb2RlLlBpbmc6XG4gICAgICAgICAgYXdhaXQgdGhpcy5lbnF1ZXVlKHtcbiAgICAgICAgICAgIG9wY29kZTogT3BDb2RlLlBvbmcsXG4gICAgICAgICAgICBwYXlsb2FkOiBmcmFtZS5wYXlsb2FkLFxuICAgICAgICAgICAgaXNMYXN0RnJhbWU6IHRydWUsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgeWllbGQgW1wicGluZ1wiLCBmcmFtZS5wYXlsb2FkXSBhcyBXZWJTb2NrZXRQaW5nRXZlbnQ7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgT3BDb2RlLlBvbmc6XG4gICAgICAgICAgeWllbGQgW1wicG9uZ1wiLCBmcmFtZS5wYXlsb2FkXSBhcyBXZWJTb2NrZXRQb25nRXZlbnQ7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBkZXF1ZXVlKCk6IHZvaWQge1xuICAgIGNvbnN0IFtlbnRyeV0gPSB0aGlzLnNlbmRRdWV1ZTtcbiAgICBpZiAoIWVudHJ5KSByZXR1cm47XG4gICAgaWYgKHRoaXMuX2lzQ2xvc2VkKSByZXR1cm47XG4gICAgY29uc3QgeyBkLCBmcmFtZSB9ID0gZW50cnk7XG4gICAgd3JpdGVGcmFtZShmcmFtZSwgdGhpcy5idWZXcml0ZXIpXG4gICAgICAudGhlbigoKSA9PiBkLnJlc29sdmUoKSlcbiAgICAgIC5jYXRjaCgoZSkgPT4gZC5yZWplY3QoZSkpXG4gICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIHRoaXMuc2VuZFF1ZXVlLnNoaWZ0KCk7XG4gICAgICAgIHRoaXMuZGVxdWV1ZSgpO1xuICAgICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGVucXVldWUoZnJhbWU6IFdlYlNvY2tldEZyYW1lKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuX2lzQ2xvc2VkKSB7XG4gICAgICB0aHJvdyBuZXcgRGVuby5lcnJvcnMuQ29ubmVjdGlvblJlc2V0KFwiU29ja2V0IGhhcyBhbHJlYWR5IGJlZW4gY2xvc2VkXCIpO1xuICAgIH1cbiAgICBjb25zdCBkID0gZGVmZXJyZWQ8dm9pZD4oKTtcbiAgICB0aGlzLnNlbmRRdWV1ZS5wdXNoKHsgZCwgZnJhbWUgfSk7XG4gICAgaWYgKHRoaXMuc2VuZFF1ZXVlLmxlbmd0aCA9PT0gMSkge1xuICAgICAgdGhpcy5kZXF1ZXVlKCk7XG4gICAgfVxuICAgIHJldHVybiBkO1xuICB9XG5cbiAgc2VuZChkYXRhOiBXZWJTb2NrZXRNZXNzYWdlKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgb3Bjb2RlID0gdHlwZW9mIGRhdGEgPT09IFwic3RyaW5nXCJcbiAgICAgID8gT3BDb2RlLlRleHRGcmFtZVxuICAgICAgOiBPcENvZGUuQmluYXJ5RnJhbWU7XG4gICAgY29uc3QgcGF5bG9hZCA9IHR5cGVvZiBkYXRhID09PSBcInN0cmluZ1wiID8gZW5jb2RlKGRhdGEpIDogZGF0YTtcbiAgICBjb25zdCBpc0xhc3RGcmFtZSA9IHRydWU7XG4gICAgY29uc3QgZnJhbWUgPSB7XG4gICAgICBpc0xhc3RGcmFtZSxcbiAgICAgIG9wY29kZSxcbiAgICAgIHBheWxvYWQsXG4gICAgICBtYXNrOiB0aGlzLm1hc2ssXG4gICAgfTtcbiAgICByZXR1cm4gdGhpcy5lbnF1ZXVlKGZyYW1lKTtcbiAgfVxuXG4gIHBpbmcoZGF0YTogV2ViU29ja2V0TWVzc2FnZSA9IFwiXCIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBwYXlsb2FkID0gdHlwZW9mIGRhdGEgPT09IFwic3RyaW5nXCIgPyBlbmNvZGUoZGF0YSkgOiBkYXRhO1xuICAgIGNvbnN0IGZyYW1lID0ge1xuICAgICAgaXNMYXN0RnJhbWU6IHRydWUsXG4gICAgICBvcGNvZGU6IE9wQ29kZS5QaW5nLFxuICAgICAgbWFzazogdGhpcy5tYXNrLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIHJldHVybiB0aGlzLmVucXVldWUoZnJhbWUpO1xuICB9XG5cbiAgcHJpdmF0ZSBfaXNDbG9zZWQgPSBmYWxzZTtcbiAgZ2V0IGlzQ2xvc2VkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLl9pc0Nsb3NlZDtcbiAgfVxuXG4gIGFzeW5jIGNsb3NlKGNvZGUgPSAxMDAwLCByZWFzb24/OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaGVhZGVyID0gW2NvZGUgPj4+IDgsIGNvZGUgJiAweDAwZmZdO1xuICAgICAgbGV0IHBheWxvYWQ6IFVpbnQ4QXJyYXk7XG4gICAgICBpZiAocmVhc29uKSB7XG4gICAgICAgIGNvbnN0IHJlYXNvbkJ5dGVzID0gZW5jb2RlKHJlYXNvbik7XG4gICAgICAgIHBheWxvYWQgPSBuZXcgVWludDhBcnJheSgyICsgcmVhc29uQnl0ZXMuYnl0ZUxlbmd0aCk7XG4gICAgICAgIHBheWxvYWQuc2V0KGhlYWRlcik7XG4gICAgICAgIHBheWxvYWQuc2V0KHJlYXNvbkJ5dGVzLCAyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBheWxvYWQgPSBuZXcgVWludDhBcnJheShoZWFkZXIpO1xuICAgICAgfVxuICAgICAgYXdhaXQgdGhpcy5lbnF1ZXVlKHtcbiAgICAgICAgaXNMYXN0RnJhbWU6IHRydWUsXG4gICAgICAgIG9wY29kZTogT3BDb2RlLkNsb3NlLFxuICAgICAgICBtYXNrOiB0aGlzLm1hc2ssXG4gICAgICAgIHBheWxvYWQsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICB0aHJvdyBlO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLmVuc3VyZVNvY2tldENsb3NlZCgpO1xuICAgIH1cbiAgfVxuXG4gIGNsb3NlRm9yY2UoKTogdm9pZCB7XG4gICAgdGhpcy5lbnN1cmVTb2NrZXRDbG9zZWQoKTtcbiAgfVxuXG4gIHByaXZhdGUgZW5zdXJlU29ja2V0Q2xvc2VkKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmlzQ2xvc2VkKSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuY29ubi5jbG9zZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMuX2lzQ2xvc2VkID0gdHJ1ZTtcbiAgICAgIGNvbnN0IHJlc3QgPSB0aGlzLnNlbmRRdWV1ZTtcbiAgICAgIHRoaXMuc2VuZFF1ZXVlID0gW107XG4gICAgICByZXN0LmZvckVhY2goKGUpID0+XG4gICAgICAgIGUuZC5yZWplY3QoXG4gICAgICAgICAgbmV3IERlbm8uZXJyb3JzLkNvbm5lY3Rpb25SZXNldChcIlNvY2tldCBoYXMgYWxyZWFkeSBiZWVuIGNsb3NlZFwiKSxcbiAgICAgICAgKVxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIFJldHVybiB3aGV0aGVyIGdpdmVuIGhlYWRlcnMgaXMgYWNjZXB0YWJsZSBmb3Igd2Vic29ja2V0ICAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFjY2VwdGFibGUocmVxOiB7IGhlYWRlcnM6IEhlYWRlcnMgfSk6IGJvb2xlYW4ge1xuICBjb25zdCB1cGdyYWRlID0gcmVxLmhlYWRlcnMuZ2V0KFwidXBncmFkZVwiKTtcbiAgaWYgKCF1cGdyYWRlIHx8IHVwZ3JhZGUudG9Mb3dlckNhc2UoKSAhPT0gXCJ3ZWJzb2NrZXRcIikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCBzZWNLZXkgPSByZXEuaGVhZGVycy5nZXQoXCJzZWMtd2Vic29ja2V0LWtleVwiKTtcbiAgcmV0dXJuIChcbiAgICByZXEuaGVhZGVycy5oYXMoXCJzZWMtd2Vic29ja2V0LWtleVwiKSAmJlxuICAgIHR5cGVvZiBzZWNLZXkgPT09IFwic3RyaW5nXCIgJiZcbiAgICBzZWNLZXkubGVuZ3RoID4gMFxuICApO1xufVxuXG5jb25zdCBrR1VJRCA9IFwiMjU4RUFGQTUtRTkxNC00N0RBLTk1Q0EtQzVBQjBEQzg1QjExXCI7XG5cbi8qKiBDcmVhdGUgc2VjLXdlYnNvY2tldC1hY2NlcHQgaGVhZGVyIHZhbHVlIHdpdGggZ2l2ZW4gbm9uY2UgKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZWNBY2NlcHQobm9uY2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHNoYTEgPSBuZXcgU2hhMSgpO1xuICBzaGExLnVwZGF0ZShub25jZSArIGtHVUlEKTtcbiAgY29uc3QgYnl0ZXMgPSBzaGExLmRpZ2VzdCgpO1xuICByZXR1cm4gYnRvYShTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzKSk7XG59XG5cbi8qKiBVcGdyYWRlIGdpdmVuIFRDUCBjb25uZWN0aW9uIGludG8gd2Vic29ja2V0IGNvbm5lY3Rpb24gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhY2NlcHRXZWJTb2NrZXQocmVxOiB7XG4gIGNvbm46IERlbm8uQ29ubjtcbiAgYnVmV3JpdGVyOiBCdWZXcml0ZXI7XG4gIGJ1ZlJlYWRlcjogQnVmUmVhZGVyO1xuICBoZWFkZXJzOiBIZWFkZXJzO1xufSk6IFByb21pc2U8V2ViU29ja2V0PiB7XG4gIGNvbnN0IHsgY29ubiwgaGVhZGVycywgYnVmUmVhZGVyLCBidWZXcml0ZXIgfSA9IHJlcTtcbiAgaWYgKGFjY2VwdGFibGUocmVxKSkge1xuICAgIGNvbnN0IHNvY2sgPSBuZXcgV2ViU29ja2V0SW1wbCh7IGNvbm4sIGJ1ZlJlYWRlciwgYnVmV3JpdGVyIH0pO1xuICAgIGNvbnN0IHNlY0tleSA9IGhlYWRlcnMuZ2V0KFwic2VjLXdlYnNvY2tldC1rZXlcIik7XG4gICAgaWYgKHR5cGVvZiBzZWNLZXkgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcInNlYy13ZWJzb2NrZXQta2V5IGlzIG5vdCBwcm92aWRlZFwiKTtcbiAgICB9XG4gICAgY29uc3Qgc2VjQWNjZXB0ID0gY3JlYXRlU2VjQWNjZXB0KHNlY0tleSk7XG4gICAgYXdhaXQgd3JpdGVSZXNwb25zZShidWZXcml0ZXIsIHtcbiAgICAgIHN0YXR1czogMTAxLFxuICAgICAgaGVhZGVyczogbmV3IEhlYWRlcnMoe1xuICAgICAgICBVcGdyYWRlOiBcIndlYnNvY2tldFwiLFxuICAgICAgICBDb25uZWN0aW9uOiBcIlVwZ3JhZGVcIixcbiAgICAgICAgXCJTZWMtV2ViU29ja2V0LUFjY2VwdFwiOiBzZWNBY2NlcHQsXG4gICAgICB9KSxcbiAgICB9KTtcbiAgICByZXR1cm4gc29jaztcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXCJyZXF1ZXN0IGlzIG5vdCBhY2NlcHRhYmxlXCIpO1xufVxuXG5jb25zdCBrU2VjQ2hhcnMgPSBcImFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVotLn5fXCI7XG5cbi8qKiBDcmVhdGUgV2ViU29ja2V0LVNlYy1LZXkuIEJhc2U2NCBlbmNvZGVkIDE2IGJ5dGVzIHN0cmluZyAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNlY0tleSgpOiBzdHJpbmcge1xuICBsZXQga2V5ID0gXCJcIjtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAxNjsgaSsrKSB7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGtTZWNDaGFycy5sZW5ndGgpO1xuICAgIGtleSArPSBrU2VjQ2hhcnNbal07XG4gIH1cbiAgcmV0dXJuIGJ0b2Eoa2V5KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRzaGFrZShcbiAgdXJsOiBVUkwsXG4gIGhlYWRlcnM6IEhlYWRlcnMsXG4gIGJ1ZlJlYWRlcjogQnVmUmVhZGVyLFxuICBidWZXcml0ZXI6IEJ1ZldyaXRlcixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IGhvc3RuYW1lLCBwYXRobmFtZSwgc2VhcmNoIH0gPSB1cmw7XG4gIGNvbnN0IGtleSA9IGNyZWF0ZVNlY0tleSgpO1xuXG4gIGlmICghaGVhZGVycy5oYXMoXCJob3N0XCIpKSB7XG4gICAgaGVhZGVycy5zZXQoXCJob3N0XCIsIGhvc3RuYW1lKTtcbiAgfVxuICBoZWFkZXJzLnNldChcInVwZ3JhZGVcIiwgXCJ3ZWJzb2NrZXRcIik7XG4gIGhlYWRlcnMuc2V0KFwiY29ubmVjdGlvblwiLCBcInVwZ3JhZGVcIik7XG4gIGhlYWRlcnMuc2V0KFwic2VjLXdlYnNvY2tldC1rZXlcIiwga2V5KTtcbiAgaGVhZGVycy5zZXQoXCJzZWMtd2Vic29ja2V0LXZlcnNpb25cIiwgXCIxM1wiKTtcblxuICBsZXQgaGVhZGVyU3RyID0gYEdFVCAke3BhdGhuYW1lfSR7c2VhcmNofSBIVFRQLzEuMVxcclxcbmA7XG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGhlYWRlcnMpIHtcbiAgICBoZWFkZXJTdHIgKz0gYCR7a2V5fTogJHt2YWx1ZX1cXHJcXG5gO1xuICB9XG4gIGhlYWRlclN0ciArPSBcIlxcclxcblwiO1xuXG4gIGF3YWl0IGJ1ZldyaXRlci53cml0ZShlbmNvZGUoaGVhZGVyU3RyKSk7XG4gIGF3YWl0IGJ1ZldyaXRlci5mbHVzaCgpO1xuXG4gIGNvbnN0IHRwUmVhZGVyID0gbmV3IFRleHRQcm90b1JlYWRlcihidWZSZWFkZXIpO1xuICBjb25zdCBzdGF0dXNMaW5lID0gYXdhaXQgdHBSZWFkZXIucmVhZExpbmUoKTtcbiAgaWYgKHN0YXR1c0xpbmUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRGVuby5lcnJvcnMuVW5leHBlY3RlZEVvZigpO1xuICB9XG4gIGNvbnN0IG0gPSBzdGF0dXNMaW5lLm1hdGNoKC9eKD88dmVyc2lvbj5cXFMrKSAoPzxzdGF0dXNDb2RlPlxcUyspIC8pO1xuICBpZiAoIW0pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJ3czogaW52YWxpZCBzdGF0dXMgbGluZTogXCIgKyBzdGF0dXNMaW5lKTtcbiAgfVxuXG4gIGFzc2VydChtLmdyb3Vwcyk7XG4gIGNvbnN0IHsgdmVyc2lvbiwgc3RhdHVzQ29kZSB9ID0gbS5ncm91cHM7XG4gIGlmICh2ZXJzaW9uICE9PSBcIkhUVFAvMS4xXCIgfHwgc3RhdHVzQ29kZSAhPT0gXCIxMDFcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGB3czogc2VydmVyIGRpZG4ndCBhY2NlcHQgaGFuZHNoYWtlOiBgICtcbiAgICAgICAgYHZlcnNpb249JHt2ZXJzaW9ufSwgc3RhdHVzQ29kZT0ke3N0YXR1c0NvZGV9YCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcmVzcG9uc2VIZWFkZXJzID0gYXdhaXQgdHBSZWFkZXIucmVhZE1JTUVIZWFkZXIoKTtcbiAgaWYgKHJlc3BvbnNlSGVhZGVycyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5VbmV4cGVjdGVkRW9mKCk7XG4gIH1cblxuICBjb25zdCBleHBlY3RlZFNlY0FjY2VwdCA9IGNyZWF0ZVNlY0FjY2VwdChrZXkpO1xuICBjb25zdCBzZWNBY2NlcHQgPSByZXNwb25zZUhlYWRlcnMuZ2V0KFwic2VjLXdlYnNvY2tldC1hY2NlcHRcIik7XG4gIGlmIChzZWNBY2NlcHQgIT09IGV4cGVjdGVkU2VjQWNjZXB0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHdzOiB1bmV4cGVjdGVkIHNlYy13ZWJzb2NrZXQtYWNjZXB0IGhlYWRlcjogYCArXG4gICAgICAgIGBleHBlY3RlZD0ke2V4cGVjdGVkU2VjQWNjZXB0fSwgYWN0dWFsPSR7c2VjQWNjZXB0fWAsXG4gICAgKTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlV2ViU29ja2V0KHBhcmFtczoge1xuICBjb25uOiBEZW5vLkNvbm47XG4gIGJ1ZldyaXRlcj86IEJ1ZldyaXRlcjtcbiAgYnVmUmVhZGVyPzogQnVmUmVhZGVyO1xuICBtYXNrPzogVWludDhBcnJheTtcbn0pOiBXZWJTb2NrZXQge1xuICByZXR1cm4gbmV3IFdlYlNvY2tldEltcGwocGFyYW1zKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwRUFBMEU7QUFDMUUsU0FBUyxNQUFNLEVBQUUsTUFBTSxRQUFRLHNCQUFzQjtBQUNyRCxTQUFTLGNBQWMsUUFBUSwrQkFBK0I7QUFDOUQsU0FBUyxTQUFTLEVBQUUsU0FBUyxRQUFRLGlCQUFpQjtBQUN0RCxTQUFTLFFBQVEsRUFBRSxTQUFTLEVBQUUsZ0JBQWdCLFFBQVEsa0JBQWtCO0FBQ3hFLFNBQVMsSUFBSSxRQUFRLGtCQUFrQjtBQUN2QyxTQUFTLGFBQWEsUUFBUSxpQkFBaUI7QUFDL0MsU0FBUyxlQUFlLFFBQVEsc0JBQXNCO0FBQ3RELFNBQW1CLFFBQVEsUUFBUSx1QkFBdUI7QUFDMUQsU0FBUyxNQUFNLFFBQVEscUJBQXFCO0FBQzVDLFNBQVMsTUFBTSxRQUFRLGtCQUFrQjtXQUVsQztVQUFLLE1BQU07SUFBTixPQUFBLE9BQ1YsY0FB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