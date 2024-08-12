// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
// Based on https://github.com/golang/go/blob/891682/src/bufio/bufio.go
// Copyright 2009 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.
import { copyBytes } from "../bytes/mod.ts";
import { assert } from "../_util/assert.ts";
const DEFAULT_BUF_SIZE = 4096;
const MIN_BUF_SIZE = 16;
const MAX_CONSECUTIVE_EMPTY_READS = 100;
const CR = "\r".charCodeAt(0);
const LF = "\n".charCodeAt(0);
export class BufferFullError extends Error {
    partial;
    name;
    constructor(partial){
        super("Buffer full");
        this.partial = partial;
        this.name = "BufferFullError";
    }
}
export class PartialReadError extends Deno.errors.UnexpectedEof {
    name = "PartialReadError";
    partial;
    constructor(){
        super("Encountered UnexpectedEof, data only partially read");
    }
}
/** BufReader implements buffering for a Reader object. */ export class BufReader {
    buf;
    rd;
    r = 0;
    w = 0;
    eof = false;
    // private lastByte: number;
    // private lastCharSize: number;
    /** return new BufReader unless r is BufReader */ static create(r, size = DEFAULT_BUF_SIZE) {
        return r instanceof BufReader ? r : new BufReader(r, size);
    }
    constructor(rd, size = DEFAULT_BUF_SIZE){
        if (size < MIN_BUF_SIZE) {
            size = MIN_BUF_SIZE;
        }
        this._reset(new Uint8Array(size), rd);
    }
    /** Returns the size of the underlying buffer in bytes. */ size() {
        return this.buf.byteLength;
    }
    buffered() {
        return this.w - this.r;
    }
    // Reads a new chunk into the buffer.
    async _fill() {
        // Slide existing data to beginning.
        if (this.r > 0) {
            this.buf.copyWithin(0, this.r, this.w);
            this.w -= this.r;
            this.r = 0;
        }
        if (this.w >= this.buf.byteLength) {
            throw Error("bufio: tried to fill full buffer");
        }
        // Read new data: try a limited number of times.
        for(let i = MAX_CONSECUTIVE_EMPTY_READS; i > 0; i--){
            const rr = await this.rd.read(this.buf.subarray(this.w));
            if (rr === null) {
                this.eof = true;
                return;
            }
            assert(rr >= 0, "negative read");
            this.w += rr;
            if (rr > 0) {
                return;
            }
        }
        throw new Error(`No progress after ${MAX_CONSECUTIVE_EMPTY_READS} read() calls`);
    }
    /** Discards any buffered data, resets all state, and switches
   * the buffered reader to read from r.
   */ reset(r) {
        this._reset(this.buf, r);
    }
    _reset(buf, rd) {
        this.buf = buf;
        this.rd = rd;
        this.eof = false;
    // this.lastByte = -1;
    // this.lastCharSize = -1;
    }
    /** reads data into p.
   * It returns the number of bytes read into p.
   * The bytes are taken from at most one Read on the underlying Reader,
   * hence n may be less than len(p).
   * To read exactly len(p) bytes, use io.ReadFull(b, p).
   */ async read(p) {
        let rr = p.byteLength;
        if (p.byteLength === 0) return rr;
        if (this.r === this.w) {
            if (p.byteLength >= this.buf.byteLength) {
                // Large read, empty buffer.
                // Read directly into p to avoid copy.
                const rr = await this.rd.read(p);
                const nread = rr ?? 0;
                assert(nread >= 0, "negative read");
                // if (rr.nread > 0) {
                //   this.lastByte = p[rr.nread - 1];
                //   this.lastCharSize = -1;
                // }
                return rr;
            }
            // One read.
            // Do not use this.fill, which will loop.
            this.r = 0;
            this.w = 0;
            rr = await this.rd.read(this.buf);
            if (rr === 0 || rr === null) return rr;
            assert(rr >= 0, "negative read");
            this.w += rr;
        }
        // copy as much as we can
        const copied = copyBytes(this.buf.subarray(this.r, this.w), p, 0);
        this.r += copied;
        // this.lastByte = this.buf[this.r - 1];
        // this.lastCharSize = -1;
        return copied;
    }
    /** reads exactly `p.length` bytes into `p`.
   *
   * If successful, `p` is returned.
   *
   * If the end of the underlying stream has been reached, and there are no more
   * bytes available in the buffer, `readFull()` returns `null` instead.
   *
   * An error is thrown if some bytes could be read, but not enough to fill `p`
   * entirely before the underlying stream reported an error or EOF. Any error
   * thrown will have a `partial` property that indicates the slice of the
   * buffer that has been successfully filled with data.
   *
   * Ported from https://golang.org/pkg/io/#ReadFull
   */ async readFull(p) {
        let bytesRead = 0;
        while(bytesRead < p.length){
            try {
                const rr = await this.read(p.subarray(bytesRead));
                if (rr === null) {
                    if (bytesRead === 0) {
                        return null;
                    } else {
                        throw new PartialReadError();
                    }
                }
                bytesRead += rr;
            } catch (err) {
                err.partial = p.subarray(0, bytesRead);
                throw err;
            }
        }
        return p;
    }
    /** Returns the next byte [0, 255] or `null`. */ async readByte() {
        while(this.r === this.w){
            if (this.eof) return null;
            await this._fill(); // buffer is empty.
        }
        const c = this.buf[this.r];
        this.r++;
        // this.lastByte = c;
        return c;
    }
    /** readString() reads until the first occurrence of delim in the input,
   * returning a string containing the data up to and including the delimiter.
   * If ReadString encounters an error before finding a delimiter,
   * it returns the data read before the error and the error itself
   * (often `null`).
   * ReadString returns err != nil if and only if the returned data does not end
   * in delim.
   * For simple uses, a Scanner may be more convenient.
   */ async readString(delim) {
        if (delim.length !== 1) {
            throw new Error("Delimiter should be a single character");
        }
        const buffer = await this.readSlice(delim.charCodeAt(0));
        if (buffer === null) return null;
        return new TextDecoder().decode(buffer);
    }
    /** `readLine()` is a low-level line-reading primitive. Most callers should
   * use `readString('\n')` instead or use a Scanner.
   *
   * `readLine()` tries to return a single line, not including the end-of-line
   * bytes. If the line was too long for the buffer then `more` is set and the
   * beginning of the line is returned. The rest of the line will be returned
   * from future calls. `more` will be false when returning the last fragment
   * of the line. The returned buffer is only valid until the next call to
   * `readLine()`.
   *
   * The text returned from ReadLine does not include the line end ("\r\n" or
   * "\n").
   *
   * When the end of the underlying stream is reached, the final bytes in the
   * stream are returned. No indication or error is given if the input ends
   * without a final line end. When there are no more trailing bytes to read,
   * `readLine()` returns `null`.
   *
   * Calling `unreadByte()` after `readLine()` will always unread the last byte
   * read (possibly a character belonging to the line end) even if that byte is
   * not part of the line returned by `readLine()`.
   */ async readLine() {
        let line;
        try {
            line = await this.readSlice(LF);
        } catch (err) {
            let { partial  } = err;
            assert(partial instanceof Uint8Array, "bufio: caught error from `readSlice()` without `partial` property");
            // Don't throw if `readSlice()` failed with `BufferFullError`, instead we
            // just return whatever is available and set the `more` flag.
            if (!(err instanceof BufferFullError)) {
                throw err;
            }
            // Handle the case where "\r\n" straddles the buffer.
            if (!this.eof && partial.byteLength > 0 && partial[partial.byteLength - 1] === CR) {
                // Put the '\r' back on buf and drop it from line.
                // Let the next call to ReadLine check for "\r\n".
                assert(this.r > 0, "bufio: tried to rewind past start of buffer");
                this.r--;
                partial = partial.subarray(0, partial.byteLength - 1);
            }
            return {
                line: partial,
                more: !this.eof
            };
        }
        if (line === null) {
            return null;
        }
        if (line.byteLength === 0) {
            return {
                line,
                more: false
            };
        }
        if (line[line.byteLength - 1] == LF) {
            let drop = 1;
            if (line.byteLength > 1 && line[line.byteLength - 2] === CR) {
                drop = 2;
            }
            line = line.subarray(0, line.byteLength - drop);
        }
        return {
            line,
            more: false
        };
    }
    /** `readSlice()` reads until the first occurrence of `delim` in the input,
   * returning a slice pointing at the bytes in the buffer. The bytes stop
   * being valid at the next read.
   *
   * If `readSlice()` encounters an error before finding a delimiter, or the
   * buffer fills without finding a delimiter, it throws an error with a
   * `partial` property that contains the entire buffer.
   *
   * If `readSlice()` encounters the end of the underlying stream and there are
   * any bytes left in the buffer, the rest of the buffer is returned. In other
   * words, EOF is always treated as a delimiter. Once the buffer is empty,
   * it returns `null`.
   *
   * Because the data returned from `readSlice()` will be overwritten by the
   * next I/O operation, most clients should use `readString()` instead.
   */ async readSlice(delim) {
        let s = 0; // search start index
        let slice;
        while(true){
            // Search buffer.
            let i = this.buf.subarray(this.r + s, this.w).indexOf(delim);
            if (i >= 0) {
                i += s;
                slice = this.buf.subarray(this.r, this.r + i + 1);
                this.r += i + 1;
                break;
            }
            // EOF?
            if (this.eof) {
                if (this.r === this.w) {
                    return null;
                }
                slice = this.buf.subarray(this.r, this.w);
                this.r = this.w;
                break;
            }
            // Buffer full?
            if (this.buffered() >= this.buf.byteLength) {
                this.r = this.w;
                // #4521 The internal buffer should not be reused across reads because it causes corruption of data.
                const oldbuf = this.buf;
                const newbuf = this.buf.slice(0);
                this.buf = newbuf;
                throw new BufferFullError(oldbuf);
            }
            s = this.w - this.r; // do not rescan area we scanned before
            // Buffer is not full.
            try {
                await this._fill();
            } catch (err) {
                err.partial = slice;
                throw err;
            }
        }
        // Handle last byte, if any.
        // const i = slice.byteLength - 1;
        // if (i >= 0) {
        //   this.lastByte = slice[i];
        //   this.lastCharSize = -1
        // }
        return slice;
    }
    /** `peek()` returns the next `n` bytes without advancing the reader. The
   * bytes stop being valid at the next read call.
   *
   * When the end of the underlying stream is reached, but there are unread
   * bytes left in the buffer, those bytes are returned. If there are no bytes
   * left in the buffer, it returns `null`.
   *
   * If an error is encountered before `n` bytes are available, `peek()` throws
   * an error with the `partial` property set to a slice of the buffer that
   * contains the bytes that were available before the error occurred.
   */ async peek(n) {
        if (n < 0) {
            throw Error("negative count");
        }
        let avail = this.w - this.r;
        while(avail < n && avail < this.buf.byteLength && !this.eof){
            try {
                await this._fill();
            } catch (err) {
                err.partial = this.buf.subarray(this.r, this.w);
                throw err;
            }
            avail = this.w - this.r;
        }
        if (avail === 0 && this.eof) {
            return null;
        } else if (avail < n && this.eof) {
            return this.buf.subarray(this.r, this.r + avail);
        } else if (avail < n) {
            throw new BufferFullError(this.buf.subarray(this.r, this.w));
        }
        return this.buf.subarray(this.r, this.r + n);
    }
}
class AbstractBufBase {
    buf;
    usedBufferBytes = 0;
    err = null;
    /** Size returns the size of the underlying buffer in bytes. */ size() {
        return this.buf.byteLength;
    }
    /** Returns how many bytes are unused in the buffer. */ available() {
        return this.buf.byteLength - this.usedBufferBytes;
    }
    /** buffered returns the number of bytes that have been written into the
   * current buffer.
   */ buffered() {
        return this.usedBufferBytes;
    }
}
/** BufWriter implements buffering for an deno.Writer object.
 * If an error occurs writing to a Writer, no more data will be
 * accepted and all subsequent writes, and flush(), will return the error.
 * After all data has been written, the client should call the
 * flush() method to guarantee all data has been forwarded to
 * the underlying deno.Writer.
 */ export class BufWriter extends AbstractBufBase {
    writer;
    /** return new BufWriter unless writer is BufWriter */ static create(writer, size = DEFAULT_BUF_SIZE) {
        return writer instanceof BufWriter ? writer : new BufWriter(writer, size);
    }
    constructor(writer, size = DEFAULT_BUF_SIZE){
        super();
        this.writer = writer;
        if (size <= 0) {
            size = DEFAULT_BUF_SIZE;
        }
        this.buf = new Uint8Array(size);
    }
    /** Discards any unflushed buffered data, clears any error, and
   * resets buffer to write its output to w.
   */ reset(w) {
        this.err = null;
        this.usedBufferBytes = 0;
        this.writer = w;
    }
    /** Flush writes any buffered data to the underlying io.Writer. */ async flush() {
        if (this.err !== null) throw this.err;
        if (this.usedBufferBytes === 0) return;
        try {
            await Deno.writeAll(this.writer, this.buf.subarray(0, this.usedBufferBytes));
        } catch (e) {
            this.err = e;
            throw e;
        }
        this.buf = new Uint8Array(this.buf.length);
        this.usedBufferBytes = 0;
    }
    /** Writes the contents of `data` into the buffer.  If the contents won't fully
   * fit into the buffer, those bytes that can are copied into the buffer, the
   * buffer is the flushed to the writer and the remaining bytes are copied into
   * the now empty buffer.
   *
   * @return the number of bytes written to the buffer.
   */ async write(data) {
        if (this.err !== null) throw this.err;
        if (data.length === 0) return 0;
        let totalBytesWritten = 0;
        let numBytesWritten = 0;
        while(data.byteLength > this.available()){
            if (this.buffered() === 0) {
                // Large write, empty buffer.
                // Write directly from data to avoid copy.
                try {
                    numBytesWritten = await this.writer.write(data);
                } catch (e) {
                    this.err = e;
                    throw e;
                }
            } else {
                numBytesWritten = copyBytes(data, this.buf, this.usedBufferBytes);
                this.usedBufferBytes += numBytesWritten;
                await this.flush();
            }
            totalBytesWritten += numBytesWritten;
            data = data.subarray(numBytesWritten);
        }
        numBytesWritten = copyBytes(data, this.buf, this.usedBufferBytes);
        this.usedBufferBytes += numBytesWritten;
        totalBytesWritten += numBytesWritten;
        return totalBytesWritten;
    }
}
/** BufWriterSync implements buffering for a deno.WriterSync object.
 * If an error occurs writing to a WriterSync, no more data will be
 * accepted and all subsequent writes, and flush(), will return the error.
 * After all data has been written, the client should call the
 * flush() method to guarantee all data has been forwarded to
 * the underlying deno.WriterSync.
 */ export class BufWriterSync extends AbstractBufBase {
    writer;
    /** return new BufWriterSync unless writer is BufWriterSync */ static create(writer, size = DEFAULT_BUF_SIZE) {
        return writer instanceof BufWriterSync ? writer : new BufWriterSync(writer, size);
    }
    constructor(writer, size = DEFAULT_BUF_SIZE){
        super();
        this.writer = writer;
        if (size <= 0) {
            size = DEFAULT_BUF_SIZE;
        }
        this.buf = new Uint8Array(size);
    }
    /** Discards any unflushed buffered data, clears any error, and
   * resets buffer to write its output to w.
   */ reset(w) {
        this.err = null;
        this.usedBufferBytes = 0;
        this.writer = w;
    }
    /** Flush writes any buffered data to the underlying io.WriterSync. */ flush() {
        if (this.err !== null) throw this.err;
        if (this.usedBufferBytes === 0) return;
        try {
            Deno.writeAllSync(this.writer, this.buf.subarray(0, this.usedBufferBytes));
        } catch (e) {
            this.err = e;
            throw e;
        }
        this.buf = new Uint8Array(this.buf.length);
        this.usedBufferBytes = 0;
    }
    /** Writes the contents of `data` into the buffer.  If the contents won't fully
   * fit into the buffer, those bytes that can are copied into the buffer, the
   * buffer is the flushed to the writer and the remaining bytes are copied into
   * the now empty buffer.
   *
   * @return the number of bytes written to the buffer.
   */ writeSync(data) {
        if (this.err !== null) throw this.err;
        if (data.length === 0) return 0;
        let totalBytesWritten = 0;
        let numBytesWritten = 0;
        while(data.byteLength > this.available()){
            if (this.buffered() === 0) {
                // Large write, empty buffer.
                // Write directly from data to avoid copy.
                try {
                    numBytesWritten = this.writer.writeSync(data);
                } catch (e) {
                    this.err = e;
                    throw e;
                }
            } else {
                numBytesWritten = copyBytes(data, this.buf, this.usedBufferBytes);
                this.usedBufferBytes += numBytesWritten;
                this.flush();
            }
            totalBytesWritten += numBytesWritten;
            data = data.subarray(numBytesWritten);
        }
        numBytesWritten = copyBytes(data, this.buf, this.usedBufferBytes);
        this.usedBufferBytes += numBytesWritten;
        totalBytesWritten += numBytesWritten;
        return totalBytesWritten;
    }
}
/** Generate longest proper prefix which is also suffix array. */ function createLPS(pat) {
    const lps = new Uint8Array(pat.length);
    lps[0] = 0;
    let prefixEnd = 0;
    let i = 1;
    while(i < lps.length){
        if (pat[i] == pat[prefixEnd]) {
            prefixEnd++;
            lps[i] = prefixEnd;
            i++;
        } else if (prefixEnd === 0) {
            lps[i] = 0;
            i++;
        } else {
            prefixEnd = pat[prefixEnd - 1];
        }
    }
    return lps;
}
/** Read delimited bytes from a Reader. */ export async function* readDelim(reader, delim) {
    // Avoid unicode problems
    const delimLen = delim.length;
    const delimLPS = createLPS(delim);
    let inputBuffer = new Deno.Buffer();
    const inspectArr = new Uint8Array(Math.max(1024, delimLen + 1));
    // Modified KMP
    let inspectIndex = 0;
    let matchIndex = 0;
    while(true){
        const result = await reader.read(inspectArr);
        if (result === null) {
            // Yield last chunk.
            yield inputBuffer.bytes();
            return;
        }
        if (result < 0) {
            // Discard all remaining and silently fail.
            return;
        }
        const sliceRead = inspectArr.subarray(0, result);
        await Deno.writeAll(inputBuffer, sliceRead);
        let sliceToProcess = inputBuffer.bytes();
        while(inspectIndex < sliceToProcess.length){
            if (sliceToProcess[inspectIndex] === delim[matchIndex]) {
                inspectIndex++;
                matchIndex++;
                if (matchIndex === delimLen) {
                    // Full match
                    const matchEnd = inspectIndex - delimLen;
                    const readyBytes = sliceToProcess.subarray(0, matchEnd);
                    // Copy
                    const pendingBytes = sliceToProcess.slice(inspectIndex);
                    yield readyBytes;
                    // Reset match, different from KMP.
                    sliceToProcess = pendingBytes;
                    inspectIndex = 0;
                    matchIndex = 0;
                }
            } else {
                if (matchIndex === 0) {
                    inspectIndex++;
                } else {
                    matchIndex = delimLPS[matchIndex - 1];
                }
            }
        }
        // Keep inspectIndex and matchIndex.
        inputBuffer = new Deno.Buffer(sliceToProcess);
    }
}
/** Read delimited strings from a Reader. */ export async function* readStringDelim(reader, delim) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    for await (const chunk of readDelim(reader, encoder.encode(delim))){
        yield decoder.decode(chunk);
    }
}
/** Read strings line-by-line from a Reader. */ // eslint-disable-next-line require-await
export async function* readLines(reader) {
    yield* readStringDelim(reader, "\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvaW8vYnVmaW8udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyMCB0aGUgRGVubyBhdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLiBNSVQgbGljZW5zZS5cbi8vIEJhc2VkIG9uIGh0dHBzOi8vZ2l0aHViLmNvbS9nb2xhbmcvZ28vYmxvYi84OTE2ODIvc3JjL2J1ZmlvL2J1ZmlvLmdvXG4vLyBDb3B5cmlnaHQgMjAwOSBUaGUgR28gQXV0aG9ycy4gQWxsIHJpZ2h0cyByZXNlcnZlZC5cbi8vIFVzZSBvZiB0aGlzIHNvdXJjZSBjb2RlIGlzIGdvdmVybmVkIGJ5IGEgQlNELXN0eWxlXG4vLyBsaWNlbnNlIHRoYXQgY2FuIGJlIGZvdW5kIGluIHRoZSBMSUNFTlNFIGZpbGUuXG5cbnR5cGUgUmVhZGVyID0gRGVuby5SZWFkZXI7XG50eXBlIFdyaXRlciA9IERlbm8uV3JpdGVyO1xudHlwZSBXcml0ZXJTeW5jID0gRGVuby5Xcml0ZXJTeW5jO1xuaW1wb3J0IHsgY29weUJ5dGVzIH0gZnJvbSBcIi4uL2J5dGVzL21vZC50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0IH0gZnJvbSBcIi4uL191dGlsL2Fzc2VydC50c1wiO1xuXG5jb25zdCBERUZBVUxUX0JVRl9TSVpFID0gNDA5NjtcbmNvbnN0IE1JTl9CVUZfU0laRSA9IDE2O1xuY29uc3QgTUFYX0NPTlNFQ1VUSVZFX0VNUFRZX1JFQURTID0gMTAwO1xuY29uc3QgQ1IgPSBcIlxcclwiLmNoYXJDb2RlQXQoMCk7XG5jb25zdCBMRiA9IFwiXFxuXCIuY2hhckNvZGVBdCgwKTtcblxuZXhwb3J0IGNsYXNzIEJ1ZmZlckZ1bGxFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgbmFtZSA9IFwiQnVmZmVyRnVsbEVycm9yXCI7XG4gIGNvbnN0cnVjdG9yKHB1YmxpYyBwYXJ0aWFsOiBVaW50OEFycmF5KSB7XG4gICAgc3VwZXIoXCJCdWZmZXIgZnVsbFwiKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgUGFydGlhbFJlYWRFcnJvciBleHRlbmRzIERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2Yge1xuICBuYW1lID0gXCJQYXJ0aWFsUmVhZEVycm9yXCI7XG4gIHBhcnRpYWw/OiBVaW50OEFycmF5O1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcihcIkVuY291bnRlcmVkIFVuZXhwZWN0ZWRFb2YsIGRhdGEgb25seSBwYXJ0aWFsbHkgcmVhZFwiKTtcbiAgfVxufVxuXG4vKiogUmVzdWx0IHR5cGUgcmV0dXJuZWQgYnkgb2YgQnVmUmVhZGVyLnJlYWRMaW5lKCkuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlYWRMaW5lUmVzdWx0IHtcbiAgbGluZTogVWludDhBcnJheTtcbiAgbW9yZTogYm9vbGVhbjtcbn1cblxuLyoqIEJ1ZlJlYWRlciBpbXBsZW1lbnRzIGJ1ZmZlcmluZyBmb3IgYSBSZWFkZXIgb2JqZWN0LiAqL1xuZXhwb3J0IGNsYXNzIEJ1ZlJlYWRlciBpbXBsZW1lbnRzIFJlYWRlciB7XG4gIHByaXZhdGUgYnVmITogVWludDhBcnJheTtcbiAgcHJpdmF0ZSByZCE6IFJlYWRlcjsgLy8gUmVhZGVyIHByb3ZpZGVkIGJ5IGNhbGxlci5cbiAgcHJpdmF0ZSByID0gMDsgLy8gYnVmIHJlYWQgcG9zaXRpb24uXG4gIHByaXZhdGUgdyA9IDA7IC8vIGJ1ZiB3cml0ZSBwb3NpdGlvbi5cbiAgcHJpdmF0ZSBlb2YgPSBmYWxzZTtcbiAgLy8gcHJpdmF0ZSBsYXN0Qnl0ZTogbnVtYmVyO1xuICAvLyBwcml2YXRlIGxhc3RDaGFyU2l6ZTogbnVtYmVyO1xuXG4gIC8qKiByZXR1cm4gbmV3IEJ1ZlJlYWRlciB1bmxlc3MgciBpcyBCdWZSZWFkZXIgKi9cbiAgc3RhdGljIGNyZWF0ZShyOiBSZWFkZXIsIHNpemU6IG51bWJlciA9IERFRkFVTFRfQlVGX1NJWkUpOiBCdWZSZWFkZXIge1xuICAgIHJldHVybiByIGluc3RhbmNlb2YgQnVmUmVhZGVyID8gciA6IG5ldyBCdWZSZWFkZXIociwgc2l6ZSk7XG4gIH1cblxuICBjb25zdHJ1Y3RvcihyZDogUmVhZGVyLCBzaXplOiBudW1iZXIgPSBERUZBVUxUX0JVRl9TSVpFKSB7XG4gICAgaWYgKHNpemUgPCBNSU5fQlVGX1NJWkUpIHtcbiAgICAgIHNpemUgPSBNSU5fQlVGX1NJWkU7XG4gICAgfVxuICAgIHRoaXMuX3Jlc2V0KG5ldyBVaW50OEFycmF5KHNpemUpLCByZCk7XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgc2l6ZSBvZiB0aGUgdW5kZXJseWluZyBidWZmZXIgaW4gYnl0ZXMuICovXG4gIHNpemUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5idWYuYnl0ZUxlbmd0aDtcbiAgfVxuXG4gIGJ1ZmZlcmVkKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMudyAtIHRoaXMucjtcbiAgfVxuXG4gIC8vIFJlYWRzIGEgbmV3IGNodW5rIGludG8gdGhlIGJ1ZmZlci5cbiAgcHJpdmF0ZSBhc3luYyBfZmlsbCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBTbGlkZSBleGlzdGluZyBkYXRhIHRvIGJlZ2lubmluZy5cbiAgICBpZiAodGhpcy5yID4gMCkge1xuICAgICAgdGhpcy5idWYuY29weVdpdGhpbigwLCB0aGlzLnIsIHRoaXMudyk7XG4gICAgICB0aGlzLncgLT0gdGhpcy5yO1xuICAgICAgdGhpcy5yID0gMDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy53ID49IHRoaXMuYnVmLmJ5dGVMZW5ndGgpIHtcbiAgICAgIHRocm93IEVycm9yKFwiYnVmaW86IHRyaWVkIHRvIGZpbGwgZnVsbCBidWZmZXJcIik7XG4gICAgfVxuXG4gICAgLy8gUmVhZCBuZXcgZGF0YTogdHJ5IGEgbGltaXRlZCBudW1iZXIgb2YgdGltZXMuXG4gICAgZm9yIChsZXQgaSA9IE1BWF9DT05TRUNVVElWRV9FTVBUWV9SRUFEUzsgaSA+IDA7IGktLSkge1xuICAgICAgY29uc3QgcnIgPSBhd2FpdCB0aGlzLnJkLnJlYWQodGhpcy5idWYuc3ViYXJyYXkodGhpcy53KSk7XG4gICAgICBpZiAocnIgPT09IG51bGwpIHtcbiAgICAgICAgdGhpcy5lb2YgPSB0cnVlO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBhc3NlcnQocnIgPj0gMCwgXCJuZWdhdGl2ZSByZWFkXCIpO1xuICAgICAgdGhpcy53ICs9IHJyO1xuICAgICAgaWYgKHJyID4gMCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYE5vIHByb2dyZXNzIGFmdGVyICR7TUFYX0NPTlNFQ1VUSVZFX0VNUFRZX1JFQURTfSByZWFkKCkgY2FsbHNgLFxuICAgICk7XG4gIH1cblxuICAvKiogRGlzY2FyZHMgYW55IGJ1ZmZlcmVkIGRhdGEsIHJlc2V0cyBhbGwgc3RhdGUsIGFuZCBzd2l0Y2hlc1xuICAgKiB0aGUgYnVmZmVyZWQgcmVhZGVyIHRvIHJlYWQgZnJvbSByLlxuICAgKi9cbiAgcmVzZXQocjogUmVhZGVyKTogdm9pZCB7XG4gICAgdGhpcy5fcmVzZXQodGhpcy5idWYsIHIpO1xuICB9XG5cbiAgcHJpdmF0ZSBfcmVzZXQoYnVmOiBVaW50OEFycmF5LCByZDogUmVhZGVyKTogdm9pZCB7XG4gICAgdGhpcy5idWYgPSBidWY7XG4gICAgdGhpcy5yZCA9IHJkO1xuICAgIHRoaXMuZW9mID0gZmFsc2U7XG4gICAgLy8gdGhpcy5sYXN0Qnl0ZSA9IC0xO1xuICAgIC8vIHRoaXMubGFzdENoYXJTaXplID0gLTE7XG4gIH1cblxuICAvKiogcmVhZHMgZGF0YSBpbnRvIHAuXG4gICAqIEl0IHJldHVybnMgdGhlIG51bWJlciBvZiBieXRlcyByZWFkIGludG8gcC5cbiAgICogVGhlIGJ5dGVzIGFyZSB0YWtlbiBmcm9tIGF0IG1vc3Qgb25lIFJlYWQgb24gdGhlIHVuZGVybHlpbmcgUmVhZGVyLFxuICAgKiBoZW5jZSBuIG1heSBiZSBsZXNzIHRoYW4gbGVuKHApLlxuICAgKiBUbyByZWFkIGV4YWN0bHkgbGVuKHApIGJ5dGVzLCB1c2UgaW8uUmVhZEZ1bGwoYiwgcCkuXG4gICAqL1xuICBhc3luYyByZWFkKHA6IFVpbnQ4QXJyYXkpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgICBsZXQgcnI6IG51bWJlciB8IG51bGwgPSBwLmJ5dGVMZW5ndGg7XG4gICAgaWYgKHAuYnl0ZUxlbmd0aCA9PT0gMCkgcmV0dXJuIHJyO1xuXG4gICAgaWYgKHRoaXMuciA9PT0gdGhpcy53KSB7XG4gICAgICBpZiAocC5ieXRlTGVuZ3RoID49IHRoaXMuYnVmLmJ5dGVMZW5ndGgpIHtcbiAgICAgICAgLy8gTGFyZ2UgcmVhZCwgZW1wdHkgYnVmZmVyLlxuICAgICAgICAvLyBSZWFkIGRpcmVjdGx5IGludG8gcCB0byBhdm9pZCBjb3B5LlxuICAgICAgICBjb25zdCByciA9IGF3YWl0IHRoaXMucmQucmVhZChwKTtcbiAgICAgICAgY29uc3QgbnJlYWQgPSByciA/PyAwO1xuICAgICAgICBhc3NlcnQobnJlYWQgPj0gMCwgXCJuZWdhdGl2ZSByZWFkXCIpO1xuICAgICAgICAvLyBpZiAocnIubnJlYWQgPiAwKSB7XG4gICAgICAgIC8vICAgdGhpcy5sYXN0Qnl0ZSA9IHBbcnIubnJlYWQgLSAxXTtcbiAgICAgICAgLy8gICB0aGlzLmxhc3RDaGFyU2l6ZSA9IC0xO1xuICAgICAgICAvLyB9XG4gICAgICAgIHJldHVybiBycjtcbiAgICAgIH1cblxuICAgICAgLy8gT25lIHJlYWQuXG4gICAgICAvLyBEbyBub3QgdXNlIHRoaXMuZmlsbCwgd2hpY2ggd2lsbCBsb29wLlxuICAgICAgdGhpcy5yID0gMDtcbiAgICAgIHRoaXMudyA9IDA7XG4gICAgICByciA9IGF3YWl0IHRoaXMucmQucmVhZCh0aGlzLmJ1Zik7XG4gICAgICBpZiAocnIgPT09IDAgfHwgcnIgPT09IG51bGwpIHJldHVybiBycjtcbiAgICAgIGFzc2VydChyciA+PSAwLCBcIm5lZ2F0aXZlIHJlYWRcIik7XG4gICAgICB0aGlzLncgKz0gcnI7XG4gICAgfVxuXG4gICAgLy8gY29weSBhcyBtdWNoIGFzIHdlIGNhblxuICAgIGNvbnN0IGNvcGllZCA9IGNvcHlCeXRlcyh0aGlzLmJ1Zi5zdWJhcnJheSh0aGlzLnIsIHRoaXMudyksIHAsIDApO1xuICAgIHRoaXMuciArPSBjb3BpZWQ7XG4gICAgLy8gdGhpcy5sYXN0Qnl0ZSA9IHRoaXMuYnVmW3RoaXMuciAtIDFdO1xuICAgIC8vIHRoaXMubGFzdENoYXJTaXplID0gLTE7XG4gICAgcmV0dXJuIGNvcGllZDtcbiAgfVxuXG4gIC8qKiByZWFkcyBleGFjdGx5IGBwLmxlbmd0aGAgYnl0ZXMgaW50byBgcGAuXG4gICAqXG4gICAqIElmIHN1Y2Nlc3NmdWwsIGBwYCBpcyByZXR1cm5lZC5cbiAgICpcbiAgICogSWYgdGhlIGVuZCBvZiB0aGUgdW5kZXJseWluZyBzdHJlYW0gaGFzIGJlZW4gcmVhY2hlZCwgYW5kIHRoZXJlIGFyZSBubyBtb3JlXG4gICAqIGJ5dGVzIGF2YWlsYWJsZSBpbiB0aGUgYnVmZmVyLCBgcmVhZEZ1bGwoKWAgcmV0dXJucyBgbnVsbGAgaW5zdGVhZC5cbiAgICpcbiAgICogQW4gZXJyb3IgaXMgdGhyb3duIGlmIHNvbWUgYnl0ZXMgY291bGQgYmUgcmVhZCwgYnV0IG5vdCBlbm91Z2ggdG8gZmlsbCBgcGBcbiAgICogZW50aXJlbHkgYmVmb3JlIHRoZSB1bmRlcmx5aW5nIHN0cmVhbSByZXBvcnRlZCBhbiBlcnJvciBvciBFT0YuIEFueSBlcnJvclxuICAgKiB0aHJvd24gd2lsbCBoYXZlIGEgYHBhcnRpYWxgIHByb3BlcnR5IHRoYXQgaW5kaWNhdGVzIHRoZSBzbGljZSBvZiB0aGVcbiAgICogYnVmZmVyIHRoYXQgaGFzIGJlZW4gc3VjY2Vzc2Z1bGx5IGZpbGxlZCB3aXRoIGRhdGEuXG4gICAqXG4gICAqIFBvcnRlZCBmcm9tIGh0dHBzOi8vZ29sYW5nLm9yZy9wa2cvaW8vI1JlYWRGdWxsXG4gICAqL1xuICBhc3luYyByZWFkRnVsbChwOiBVaW50OEFycmF5KTogUHJvbWlzZTxVaW50OEFycmF5IHwgbnVsbD4ge1xuICAgIGxldCBieXRlc1JlYWQgPSAwO1xuICAgIHdoaWxlIChieXRlc1JlYWQgPCBwLmxlbmd0aCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcnIgPSBhd2FpdCB0aGlzLnJlYWQocC5zdWJhcnJheShieXRlc1JlYWQpKTtcbiAgICAgICAgaWYgKHJyID09PSBudWxsKSB7XG4gICAgICAgICAgaWYgKGJ5dGVzUmVhZCA9PT0gMCkge1xuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJ0aWFsUmVhZEVycm9yKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJ5dGVzUmVhZCArPSBycjtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBlcnIucGFydGlhbCA9IHAuc3ViYXJyYXkoMCwgYnl0ZXNSZWFkKTtcbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcDtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRoZSBuZXh0IGJ5dGUgWzAsIDI1NV0gb3IgYG51bGxgLiAqL1xuICBhc3luYyByZWFkQnl0ZSgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgICB3aGlsZSAodGhpcy5yID09PSB0aGlzLncpIHtcbiAgICAgIGlmICh0aGlzLmVvZikgcmV0dXJuIG51bGw7XG4gICAgICBhd2FpdCB0aGlzLl9maWxsKCk7IC8vIGJ1ZmZlciBpcyBlbXB0eS5cbiAgICB9XG4gICAgY29uc3QgYyA9IHRoaXMuYnVmW3RoaXMucl07XG4gICAgdGhpcy5yKys7XG4gICAgLy8gdGhpcy5sYXN0Qnl0ZSA9IGM7XG4gICAgcmV0dXJuIGM7XG4gIH1cblxuICAvKiogcmVhZFN0cmluZygpIHJlYWRzIHVudGlsIHRoZSBmaXJzdCBvY2N1cnJlbmNlIG9mIGRlbGltIGluIHRoZSBpbnB1dCxcbiAgICogcmV0dXJuaW5nIGEgc3RyaW5nIGNvbnRhaW5pbmcgdGhlIGRhdGEgdXAgdG8gYW5kIGluY2x1ZGluZyB0aGUgZGVsaW1pdGVyLlxuICAgKiBJZiBSZWFkU3RyaW5nIGVuY291bnRlcnMgYW4gZXJyb3IgYmVmb3JlIGZpbmRpbmcgYSBkZWxpbWl0ZXIsXG4gICAqIGl0IHJldHVybnMgdGhlIGRhdGEgcmVhZCBiZWZvcmUgdGhlIGVycm9yIGFuZCB0aGUgZXJyb3IgaXRzZWxmXG4gICAqIChvZnRlbiBgbnVsbGApLlxuICAgKiBSZWFkU3RyaW5nIHJldHVybnMgZXJyICE9IG5pbCBpZiBhbmQgb25seSBpZiB0aGUgcmV0dXJuZWQgZGF0YSBkb2VzIG5vdCBlbmRcbiAgICogaW4gZGVsaW0uXG4gICAqIEZvciBzaW1wbGUgdXNlcywgYSBTY2FubmVyIG1heSBiZSBtb3JlIGNvbnZlbmllbnQuXG4gICAqL1xuICBhc3luYyByZWFkU3RyaW5nKGRlbGltOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICBpZiAoZGVsaW0ubGVuZ3RoICE9PSAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJEZWxpbWl0ZXIgc2hvdWxkIGJlIGEgc2luZ2xlIGNoYXJhY3RlclwiKTtcbiAgICB9XG4gICAgY29uc3QgYnVmZmVyID0gYXdhaXQgdGhpcy5yZWFkU2xpY2UoZGVsaW0uY2hhckNvZGVBdCgwKSk7XG4gICAgaWYgKGJ1ZmZlciA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShidWZmZXIpO1xuICB9XG5cbiAgLyoqIGByZWFkTGluZSgpYCBpcyBhIGxvdy1sZXZlbCBsaW5lLXJlYWRpbmcgcHJpbWl0aXZlLiBNb3N0IGNhbGxlcnMgc2hvdWxkXG4gICAqIHVzZSBgcmVhZFN0cmluZygnXFxuJylgIGluc3RlYWQgb3IgdXNlIGEgU2Nhbm5lci5cbiAgICpcbiAgICogYHJlYWRMaW5lKClgIHRyaWVzIHRvIHJldHVybiBhIHNpbmdsZSBsaW5lLCBub3QgaW5jbHVkaW5nIHRoZSBlbmQtb2YtbGluZVxuICAgKiBieXRlcy4gSWYgdGhlIGxpbmUgd2FzIHRvbyBsb25nIGZvciB0aGUgYnVmZmVyIHRoZW4gYG1vcmVgIGlzIHNldCBhbmQgdGhlXG4gICAqIGJlZ2lubmluZyBvZiB0aGUgbGluZSBpcyByZXR1cm5lZC4gVGhlIHJlc3Qgb2YgdGhlIGxpbmUgd2lsbCBiZSByZXR1cm5lZFxuICAgKiBmcm9tIGZ1dHVyZSBjYWxscy4gYG1vcmVgIHdpbGwgYmUgZmFsc2Ugd2hlbiByZXR1cm5pbmcgdGhlIGxhc3QgZnJhZ21lbnRcbiAgICogb2YgdGhlIGxpbmUuIFRoZSByZXR1cm5lZCBidWZmZXIgaXMgb25seSB2YWxpZCB1bnRpbCB0aGUgbmV4dCBjYWxsIHRvXG4gICAqIGByZWFkTGluZSgpYC5cbiAgICpcbiAgICogVGhlIHRleHQgcmV0dXJuZWQgZnJvbSBSZWFkTGluZSBkb2VzIG5vdCBpbmNsdWRlIHRoZSBsaW5lIGVuZCAoXCJcXHJcXG5cIiBvclxuICAgKiBcIlxcblwiKS5cbiAgICpcbiAgICogV2hlbiB0aGUgZW5kIG9mIHRoZSB1bmRlcmx5aW5nIHN0cmVhbSBpcyByZWFjaGVkLCB0aGUgZmluYWwgYnl0ZXMgaW4gdGhlXG4gICAqIHN0cmVhbSBhcmUgcmV0dXJuZWQuIE5vIGluZGljYXRpb24gb3IgZXJyb3IgaXMgZ2l2ZW4gaWYgdGhlIGlucHV0IGVuZHNcbiAgICogd2l0aG91dCBhIGZpbmFsIGxpbmUgZW5kLiBXaGVuIHRoZXJlIGFyZSBubyBtb3JlIHRyYWlsaW5nIGJ5dGVzIHRvIHJlYWQsXG4gICAqIGByZWFkTGluZSgpYCByZXR1cm5zIGBudWxsYC5cbiAgICpcbiAgICogQ2FsbGluZyBgdW5yZWFkQnl0ZSgpYCBhZnRlciBgcmVhZExpbmUoKWAgd2lsbCBhbHdheXMgdW5yZWFkIHRoZSBsYXN0IGJ5dGVcbiAgICogcmVhZCAocG9zc2libHkgYSBjaGFyYWN0ZXIgYmVsb25naW5nIHRvIHRoZSBsaW5lIGVuZCkgZXZlbiBpZiB0aGF0IGJ5dGUgaXNcbiAgICogbm90IHBhcnQgb2YgdGhlIGxpbmUgcmV0dXJuZWQgYnkgYHJlYWRMaW5lKClgLlxuICAgKi9cbiAgYXN5bmMgcmVhZExpbmUoKTogUHJvbWlzZTxSZWFkTGluZVJlc3VsdCB8IG51bGw+IHtcbiAgICBsZXQgbGluZTogVWludDhBcnJheSB8IG51bGw7XG5cbiAgICB0cnkge1xuICAgICAgbGluZSA9IGF3YWl0IHRoaXMucmVhZFNsaWNlKExGKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxldCB7IHBhcnRpYWwgfSA9IGVycjtcbiAgICAgIGFzc2VydChcbiAgICAgICAgcGFydGlhbCBpbnN0YW5jZW9mIFVpbnQ4QXJyYXksXG4gICAgICAgIFwiYnVmaW86IGNhdWdodCBlcnJvciBmcm9tIGByZWFkU2xpY2UoKWAgd2l0aG91dCBgcGFydGlhbGAgcHJvcGVydHlcIixcbiAgICAgICk7XG5cbiAgICAgIC8vIERvbid0IHRocm93IGlmIGByZWFkU2xpY2UoKWAgZmFpbGVkIHdpdGggYEJ1ZmZlckZ1bGxFcnJvcmAsIGluc3RlYWQgd2VcbiAgICAgIC8vIGp1c3QgcmV0dXJuIHdoYXRldmVyIGlzIGF2YWlsYWJsZSBhbmQgc2V0IHRoZSBgbW9yZWAgZmxhZy5cbiAgICAgIGlmICghKGVyciBpbnN0YW5jZW9mIEJ1ZmZlckZ1bGxFcnJvcikpIHtcbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuXG4gICAgICAvLyBIYW5kbGUgdGhlIGNhc2Ugd2hlcmUgXCJcXHJcXG5cIiBzdHJhZGRsZXMgdGhlIGJ1ZmZlci5cbiAgICAgIGlmIChcbiAgICAgICAgIXRoaXMuZW9mICYmXG4gICAgICAgIHBhcnRpYWwuYnl0ZUxlbmd0aCA+IDAgJiZcbiAgICAgICAgcGFydGlhbFtwYXJ0aWFsLmJ5dGVMZW5ndGggLSAxXSA9PT0gQ1JcbiAgICAgICkge1xuICAgICAgICAvLyBQdXQgdGhlICdcXHInIGJhY2sgb24gYnVmIGFuZCBkcm9wIGl0IGZyb20gbGluZS5cbiAgICAgICAgLy8gTGV0IHRoZSBuZXh0IGNhbGwgdG8gUmVhZExpbmUgY2hlY2sgZm9yIFwiXFxyXFxuXCIuXG4gICAgICAgIGFzc2VydCh0aGlzLnIgPiAwLCBcImJ1ZmlvOiB0cmllZCB0byByZXdpbmQgcGFzdCBzdGFydCBvZiBidWZmZXJcIik7XG4gICAgICAgIHRoaXMuci0tO1xuICAgICAgICBwYXJ0aWFsID0gcGFydGlhbC5zdWJhcnJheSgwLCBwYXJ0aWFsLmJ5dGVMZW5ndGggLSAxKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHsgbGluZTogcGFydGlhbCwgbW9yZTogIXRoaXMuZW9mIH07XG4gICAgfVxuXG4gICAgaWYgKGxpbmUgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGlmIChsaW5lLmJ5dGVMZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiB7IGxpbmUsIG1vcmU6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgaWYgKGxpbmVbbGluZS5ieXRlTGVuZ3RoIC0gMV0gPT0gTEYpIHtcbiAgICAgIGxldCBkcm9wID0gMTtcbiAgICAgIGlmIChsaW5lLmJ5dGVMZW5ndGggPiAxICYmIGxpbmVbbGluZS5ieXRlTGVuZ3RoIC0gMl0gPT09IENSKSB7XG4gICAgICAgIGRyb3AgPSAyO1xuICAgICAgfVxuICAgICAgbGluZSA9IGxpbmUuc3ViYXJyYXkoMCwgbGluZS5ieXRlTGVuZ3RoIC0gZHJvcCk7XG4gICAgfVxuICAgIHJldHVybiB7IGxpbmUsIG1vcmU6IGZhbHNlIH07XG4gIH1cblxuICAvKiogYHJlYWRTbGljZSgpYCByZWFkcyB1bnRpbCB0aGUgZmlyc3Qgb2NjdXJyZW5jZSBvZiBgZGVsaW1gIGluIHRoZSBpbnB1dCxcbiAgICogcmV0dXJuaW5nIGEgc2xpY2UgcG9pbnRpbmcgYXQgdGhlIGJ5dGVzIGluIHRoZSBidWZmZXIuIFRoZSBieXRlcyBzdG9wXG4gICAqIGJlaW5nIHZhbGlkIGF0IHRoZSBuZXh0IHJlYWQuXG4gICAqXG4gICAqIElmIGByZWFkU2xpY2UoKWAgZW5jb3VudGVycyBhbiBlcnJvciBiZWZvcmUgZmluZGluZyBhIGRlbGltaXRlciwgb3IgdGhlXG4gICAqIGJ1ZmZlciBmaWxscyB3aXRob3V0IGZpbmRpbmcgYSBkZWxpbWl0ZXIsIGl0IHRocm93cyBhbiBlcnJvciB3aXRoIGFcbiAgICogYHBhcnRpYWxgIHByb3BlcnR5IHRoYXQgY29udGFpbnMgdGhlIGVudGlyZSBidWZmZXIuXG4gICAqXG4gICAqIElmIGByZWFkU2xpY2UoKWAgZW5jb3VudGVycyB0aGUgZW5kIG9mIHRoZSB1bmRlcmx5aW5nIHN0cmVhbSBhbmQgdGhlcmUgYXJlXG4gICAqIGFueSBieXRlcyBsZWZ0IGluIHRoZSBidWZmZXIsIHRoZSByZXN0IG9mIHRoZSBidWZmZXIgaXMgcmV0dXJuZWQuIEluIG90aGVyXG4gICAqIHdvcmRzLCBFT0YgaXMgYWx3YXlzIHRyZWF0ZWQgYXMgYSBkZWxpbWl0ZXIuIE9uY2UgdGhlIGJ1ZmZlciBpcyBlbXB0eSxcbiAgICogaXQgcmV0dXJucyBgbnVsbGAuXG4gICAqXG4gICAqIEJlY2F1c2UgdGhlIGRhdGEgcmV0dXJuZWQgZnJvbSBgcmVhZFNsaWNlKClgIHdpbGwgYmUgb3ZlcndyaXR0ZW4gYnkgdGhlXG4gICAqIG5leHQgSS9PIG9wZXJhdGlvbiwgbW9zdCBjbGllbnRzIHNob3VsZCB1c2UgYHJlYWRTdHJpbmcoKWAgaW5zdGVhZC5cbiAgICovXG4gIGFzeW5jIHJlYWRTbGljZShkZWxpbTogbnVtYmVyKTogUHJvbWlzZTxVaW50OEFycmF5IHwgbnVsbD4ge1xuICAgIGxldCBzID0gMDsgLy8gc2VhcmNoIHN0YXJ0IGluZGV4XG4gICAgbGV0IHNsaWNlOiBVaW50OEFycmF5IHwgdW5kZWZpbmVkO1xuXG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIC8vIFNlYXJjaCBidWZmZXIuXG4gICAgICBsZXQgaSA9IHRoaXMuYnVmLnN1YmFycmF5KHRoaXMuciArIHMsIHRoaXMudykuaW5kZXhPZihkZWxpbSk7XG4gICAgICBpZiAoaSA+PSAwKSB7XG4gICAgICAgIGkgKz0gcztcbiAgICAgICAgc2xpY2UgPSB0aGlzLmJ1Zi5zdWJhcnJheSh0aGlzLnIsIHRoaXMuciArIGkgKyAxKTtcbiAgICAgICAgdGhpcy5yICs9IGkgKyAxO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gRU9GP1xuICAgICAgaWYgKHRoaXMuZW9mKSB7XG4gICAgICAgIGlmICh0aGlzLnIgPT09IHRoaXMudykge1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgICAgIHNsaWNlID0gdGhpcy5idWYuc3ViYXJyYXkodGhpcy5yLCB0aGlzLncpO1xuICAgICAgICB0aGlzLnIgPSB0aGlzLnc7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBCdWZmZXIgZnVsbD9cbiAgICAgIGlmICh0aGlzLmJ1ZmZlcmVkKCkgPj0gdGhpcy5idWYuYnl0ZUxlbmd0aCkge1xuICAgICAgICB0aGlzLnIgPSB0aGlzLnc7XG4gICAgICAgIC8vICM0NTIxIFRoZSBpbnRlcm5hbCBidWZmZXIgc2hvdWxkIG5vdCBiZSByZXVzZWQgYWNyb3NzIHJlYWRzIGJlY2F1c2UgaXQgY2F1c2VzIGNvcnJ1cHRpb24gb2YgZGF0YS5cbiAgICAgICAgY29uc3Qgb2xkYnVmID0gdGhpcy5idWY7XG4gICAgICAgIGNvbnN0IG5ld2J1ZiA9IHRoaXMuYnVmLnNsaWNlKDApO1xuICAgICAgICB0aGlzLmJ1ZiA9IG5ld2J1ZjtcbiAgICAgICAgdGhyb3cgbmV3IEJ1ZmZlckZ1bGxFcnJvcihvbGRidWYpO1xuICAgICAgfVxuXG4gICAgICBzID0gdGhpcy53IC0gdGhpcy5yOyAvLyBkbyBub3QgcmVzY2FuIGFyZWEgd2Ugc2Nhbm5lZCBiZWZvcmVcblxuICAgICAgLy8gQnVmZmVyIGlzIG5vdCBmdWxsLlxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5fZmlsbCgpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGVyci5wYXJ0aWFsID0gc2xpY2U7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBIYW5kbGUgbGFzdCBieXRlLCBpZiBhbnkuXG4gICAgLy8gY29uc3QgaSA9IHNsaWNlLmJ5dGVMZW5ndGggLSAxO1xuICAgIC8vIGlmIChpID49IDApIHtcbiAgICAvLyAgIHRoaXMubGFzdEJ5dGUgPSBzbGljZVtpXTtcbiAgICAvLyAgIHRoaXMubGFzdENoYXJTaXplID0gLTFcbiAgICAvLyB9XG5cbiAgICByZXR1cm4gc2xpY2U7XG4gIH1cblxuICAvKiogYHBlZWsoKWAgcmV0dXJucyB0aGUgbmV4dCBgbmAgYnl0ZXMgd2l0aG91dCBhZHZhbmNpbmcgdGhlIHJlYWRlci4gVGhlXG4gICAqIGJ5dGVzIHN0b3AgYmVpbmcgdmFsaWQgYXQgdGhlIG5leHQgcmVhZCBjYWxsLlxuICAgKlxuICAgKiBXaGVuIHRoZSBlbmQgb2YgdGhlIHVuZGVybHlpbmcgc3RyZWFtIGlzIHJlYWNoZWQsIGJ1dCB0aGVyZSBhcmUgdW5yZWFkXG4gICAqIGJ5dGVzIGxlZnQgaW4gdGhlIGJ1ZmZlciwgdGhvc2UgYnl0ZXMgYXJlIHJldHVybmVkLiBJZiB0aGVyZSBhcmUgbm8gYnl0ZXNcbiAgICogbGVmdCBpbiB0aGUgYnVmZmVyLCBpdCByZXR1cm5zIGBudWxsYC5cbiAgICpcbiAgICogSWYgYW4gZXJyb3IgaXMgZW5jb3VudGVyZWQgYmVmb3JlIGBuYCBieXRlcyBhcmUgYXZhaWxhYmxlLCBgcGVlaygpYCB0aHJvd3NcbiAgICogYW4gZXJyb3Igd2l0aCB0aGUgYHBhcnRpYWxgIHByb3BlcnR5IHNldCB0byBhIHNsaWNlIG9mIHRoZSBidWZmZXIgdGhhdFxuICAgKiBjb250YWlucyB0aGUgYnl0ZXMgdGhhdCB3ZXJlIGF2YWlsYWJsZSBiZWZvcmUgdGhlIGVycm9yIG9jY3VycmVkLlxuICAgKi9cbiAgYXN5bmMgcGVlayhuOiBudW1iZXIpOiBQcm9taXNlPFVpbnQ4QXJyYXkgfCBudWxsPiB7XG4gICAgaWYgKG4gPCAwKSB7XG4gICAgICB0aHJvdyBFcnJvcihcIm5lZ2F0aXZlIGNvdW50XCIpO1xuICAgIH1cblxuICAgIGxldCBhdmFpbCA9IHRoaXMudyAtIHRoaXMucjtcbiAgICB3aGlsZSAoYXZhaWwgPCBuICYmIGF2YWlsIDwgdGhpcy5idWYuYnl0ZUxlbmd0aCAmJiAhdGhpcy5lb2YpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuX2ZpbGwoKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBlcnIucGFydGlhbCA9IHRoaXMuYnVmLnN1YmFycmF5KHRoaXMuciwgdGhpcy53KTtcbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgICAgYXZhaWwgPSB0aGlzLncgLSB0aGlzLnI7XG4gICAgfVxuXG4gICAgaWYgKGF2YWlsID09PSAwICYmIHRoaXMuZW9mKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2UgaWYgKGF2YWlsIDwgbiAmJiB0aGlzLmVvZikge1xuICAgICAgcmV0dXJuIHRoaXMuYnVmLnN1YmFycmF5KHRoaXMuciwgdGhpcy5yICsgYXZhaWwpO1xuICAgIH0gZWxzZSBpZiAoYXZhaWwgPCBuKSB7XG4gICAgICB0aHJvdyBuZXcgQnVmZmVyRnVsbEVycm9yKHRoaXMuYnVmLnN1YmFycmF5KHRoaXMuciwgdGhpcy53KSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuYnVmLnN1YmFycmF5KHRoaXMuciwgdGhpcy5yICsgbik7XG4gIH1cbn1cblxuYWJzdHJhY3QgY2xhc3MgQWJzdHJhY3RCdWZCYXNlIHtcbiAgYnVmITogVWludDhBcnJheTtcbiAgdXNlZEJ1ZmZlckJ5dGVzID0gMDtcbiAgZXJyOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXG4gIC8qKiBTaXplIHJldHVybnMgdGhlIHNpemUgb2YgdGhlIHVuZGVybHlpbmcgYnVmZmVyIGluIGJ5dGVzLiAqL1xuICBzaXplKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuYnVmLmJ5dGVMZW5ndGg7XG4gIH1cblxuICAvKiogUmV0dXJucyBob3cgbWFueSBieXRlcyBhcmUgdW51c2VkIGluIHRoZSBidWZmZXIuICovXG4gIGF2YWlsYWJsZSgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmJ1Zi5ieXRlTGVuZ3RoIC0gdGhpcy51c2VkQnVmZmVyQnl0ZXM7XG4gIH1cblxuICAvKiogYnVmZmVyZWQgcmV0dXJucyB0aGUgbnVtYmVyIG9mIGJ5dGVzIHRoYXQgaGF2ZSBiZWVuIHdyaXR0ZW4gaW50byB0aGVcbiAgICogY3VycmVudCBidWZmZXIuXG4gICAqL1xuICBidWZmZXJlZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnVzZWRCdWZmZXJCeXRlcztcbiAgfVxufVxuXG4vKiogQnVmV3JpdGVyIGltcGxlbWVudHMgYnVmZmVyaW5nIGZvciBhbiBkZW5vLldyaXRlciBvYmplY3QuXG4gKiBJZiBhbiBlcnJvciBvY2N1cnMgd3JpdGluZyB0byBhIFdyaXRlciwgbm8gbW9yZSBkYXRhIHdpbGwgYmVcbiAqIGFjY2VwdGVkIGFuZCBhbGwgc3Vic2VxdWVudCB3cml0ZXMsIGFuZCBmbHVzaCgpLCB3aWxsIHJldHVybiB0aGUgZXJyb3IuXG4gKiBBZnRlciBhbGwgZGF0YSBoYXMgYmVlbiB3cml0dGVuLCB0aGUgY2xpZW50IHNob3VsZCBjYWxsIHRoZVxuICogZmx1c2goKSBtZXRob2QgdG8gZ3VhcmFudGVlIGFsbCBkYXRhIGhhcyBiZWVuIGZvcndhcmRlZCB0b1xuICogdGhlIHVuZGVybHlpbmcgZGVuby5Xcml0ZXIuXG4gKi9cbmV4cG9ydCBjbGFzcyBCdWZXcml0ZXIgZXh0ZW5kcyBBYnN0cmFjdEJ1ZkJhc2UgaW1wbGVtZW50cyBXcml0ZXIge1xuICAvKiogcmV0dXJuIG5ldyBCdWZXcml0ZXIgdW5sZXNzIHdyaXRlciBpcyBCdWZXcml0ZXIgKi9cbiAgc3RhdGljIGNyZWF0ZSh3cml0ZXI6IFdyaXRlciwgc2l6ZTogbnVtYmVyID0gREVGQVVMVF9CVUZfU0laRSk6IEJ1ZldyaXRlciB7XG4gICAgcmV0dXJuIHdyaXRlciBpbnN0YW5jZW9mIEJ1ZldyaXRlciA/IHdyaXRlciA6IG5ldyBCdWZXcml0ZXIod3JpdGVyLCBzaXplKTtcbiAgfVxuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgd3JpdGVyOiBXcml0ZXIsIHNpemU6IG51bWJlciA9IERFRkFVTFRfQlVGX1NJWkUpIHtcbiAgICBzdXBlcigpO1xuICAgIGlmIChzaXplIDw9IDApIHtcbiAgICAgIHNpemUgPSBERUZBVUxUX0JVRl9TSVpFO1xuICAgIH1cbiAgICB0aGlzLmJ1ZiA9IG5ldyBVaW50OEFycmF5KHNpemUpO1xuICB9XG5cbiAgLyoqIERpc2NhcmRzIGFueSB1bmZsdXNoZWQgYnVmZmVyZWQgZGF0YSwgY2xlYXJzIGFueSBlcnJvciwgYW5kXG4gICAqIHJlc2V0cyBidWZmZXIgdG8gd3JpdGUgaXRzIG91dHB1dCB0byB3LlxuICAgKi9cbiAgcmVzZXQodzogV3JpdGVyKTogdm9pZCB7XG4gICAgdGhpcy5lcnIgPSBudWxsO1xuICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzID0gMDtcbiAgICB0aGlzLndyaXRlciA9IHc7XG4gIH1cblxuICAvKiogRmx1c2ggd3JpdGVzIGFueSBidWZmZXJlZCBkYXRhIHRvIHRoZSB1bmRlcmx5aW5nIGlvLldyaXRlci4gKi9cbiAgYXN5bmMgZmx1c2goKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuZXJyICE9PSBudWxsKSB0aHJvdyB0aGlzLmVycjtcbiAgICBpZiAodGhpcy51c2VkQnVmZmVyQnl0ZXMgPT09IDApIHJldHVybjtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLndyaXRlQWxsKFxuICAgICAgICB0aGlzLndyaXRlcixcbiAgICAgICAgdGhpcy5idWYuc3ViYXJyYXkoMCwgdGhpcy51c2VkQnVmZmVyQnl0ZXMpLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICB0aGlzLmVyciA9IGU7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cblxuICAgIHRoaXMuYnVmID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5idWYubGVuZ3RoKTtcbiAgICB0aGlzLnVzZWRCdWZmZXJCeXRlcyA9IDA7XG4gIH1cblxuICAvKiogV3JpdGVzIHRoZSBjb250ZW50cyBvZiBgZGF0YWAgaW50byB0aGUgYnVmZmVyLiAgSWYgdGhlIGNvbnRlbnRzIHdvbid0IGZ1bGx5XG4gICAqIGZpdCBpbnRvIHRoZSBidWZmZXIsIHRob3NlIGJ5dGVzIHRoYXQgY2FuIGFyZSBjb3BpZWQgaW50byB0aGUgYnVmZmVyLCB0aGVcbiAgICogYnVmZmVyIGlzIHRoZSBmbHVzaGVkIHRvIHRoZSB3cml0ZXIgYW5kIHRoZSByZW1haW5pbmcgYnl0ZXMgYXJlIGNvcGllZCBpbnRvXG4gICAqIHRoZSBub3cgZW1wdHkgYnVmZmVyLlxuICAgKlxuICAgKiBAcmV0dXJuIHRoZSBudW1iZXIgb2YgYnl0ZXMgd3JpdHRlbiB0byB0aGUgYnVmZmVyLlxuICAgKi9cbiAgYXN5bmMgd3JpdGUoZGF0YTogVWludDhBcnJheSk6IFByb21pc2U8bnVtYmVyPiB7XG4gICAgaWYgKHRoaXMuZXJyICE9PSBudWxsKSB0aHJvdyB0aGlzLmVycjtcbiAgICBpZiAoZGF0YS5sZW5ndGggPT09IDApIHJldHVybiAwO1xuXG4gICAgbGV0IHRvdGFsQnl0ZXNXcml0dGVuID0gMDtcbiAgICBsZXQgbnVtQnl0ZXNXcml0dGVuID0gMDtcbiAgICB3aGlsZSAoZGF0YS5ieXRlTGVuZ3RoID4gdGhpcy5hdmFpbGFibGUoKSkge1xuICAgICAgaWYgKHRoaXMuYnVmZmVyZWQoKSA9PT0gMCkge1xuICAgICAgICAvLyBMYXJnZSB3cml0ZSwgZW1wdHkgYnVmZmVyLlxuICAgICAgICAvLyBXcml0ZSBkaXJlY3RseSBmcm9tIGRhdGEgdG8gYXZvaWQgY29weS5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBudW1CeXRlc1dyaXR0ZW4gPSBhd2FpdCB0aGlzLndyaXRlci53cml0ZShkYXRhKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHRoaXMuZXJyID0gZTtcbiAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBudW1CeXRlc1dyaXR0ZW4gPSBjb3B5Qnl0ZXMoZGF0YSwgdGhpcy5idWYsIHRoaXMudXNlZEJ1ZmZlckJ5dGVzKTtcbiAgICAgICAgdGhpcy51c2VkQnVmZmVyQnl0ZXMgKz0gbnVtQnl0ZXNXcml0dGVuO1xuICAgICAgICBhd2FpdCB0aGlzLmZsdXNoKCk7XG4gICAgICB9XG4gICAgICB0b3RhbEJ5dGVzV3JpdHRlbiArPSBudW1CeXRlc1dyaXR0ZW47XG4gICAgICBkYXRhID0gZGF0YS5zdWJhcnJheShudW1CeXRlc1dyaXR0ZW4pO1xuICAgIH1cblxuICAgIG51bUJ5dGVzV3JpdHRlbiA9IGNvcHlCeXRlcyhkYXRhLCB0aGlzLmJ1ZiwgdGhpcy51c2VkQnVmZmVyQnl0ZXMpO1xuICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzICs9IG51bUJ5dGVzV3JpdHRlbjtcbiAgICB0b3RhbEJ5dGVzV3JpdHRlbiArPSBudW1CeXRlc1dyaXR0ZW47XG4gICAgcmV0dXJuIHRvdGFsQnl0ZXNXcml0dGVuO1xuICB9XG59XG5cbi8qKiBCdWZXcml0ZXJTeW5jIGltcGxlbWVudHMgYnVmZmVyaW5nIGZvciBhIGRlbm8uV3JpdGVyU3luYyBvYmplY3QuXG4gKiBJZiBhbiBlcnJvciBvY2N1cnMgd3JpdGluZyB0byBhIFdyaXRlclN5bmMsIG5vIG1vcmUgZGF0YSB3aWxsIGJlXG4gKiBhY2NlcHRlZCBhbmQgYWxsIHN1YnNlcXVlbnQgd3JpdGVzLCBhbmQgZmx1c2goKSwgd2lsbCByZXR1cm4gdGhlIGVycm9yLlxuICogQWZ0ZXIgYWxsIGRhdGEgaGFzIGJlZW4gd3JpdHRlbiwgdGhlIGNsaWVudCBzaG91bGQgY2FsbCB0aGVcbiAqIGZsdXNoKCkgbWV0aG9kIHRvIGd1YXJhbnRlZSBhbGwgZGF0YSBoYXMgYmVlbiBmb3J3YXJkZWQgdG9cbiAqIHRoZSB1bmRlcmx5aW5nIGRlbm8uV3JpdGVyU3luYy5cbiAqL1xuZXhwb3J0IGNsYXNzIEJ1ZldyaXRlclN5bmMgZXh0ZW5kcyBBYnN0cmFjdEJ1ZkJhc2UgaW1wbGVtZW50cyBXcml0ZXJTeW5jIHtcbiAgLyoqIHJldHVybiBuZXcgQnVmV3JpdGVyU3luYyB1bmxlc3Mgd3JpdGVyIGlzIEJ1ZldyaXRlclN5bmMgKi9cbiAgc3RhdGljIGNyZWF0ZShcbiAgICB3cml0ZXI6IFdyaXRlclN5bmMsXG4gICAgc2l6ZTogbnVtYmVyID0gREVGQVVMVF9CVUZfU0laRSxcbiAgKTogQnVmV3JpdGVyU3luYyB7XG4gICAgcmV0dXJuIHdyaXRlciBpbnN0YW5jZW9mIEJ1ZldyaXRlclN5bmNcbiAgICAgID8gd3JpdGVyXG4gICAgICA6IG5ldyBCdWZXcml0ZXJTeW5jKHdyaXRlciwgc2l6ZSk7XG4gIH1cblxuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHdyaXRlcjogV3JpdGVyU3luYywgc2l6ZTogbnVtYmVyID0gREVGQVVMVF9CVUZfU0laRSkge1xuICAgIHN1cGVyKCk7XG4gICAgaWYgKHNpemUgPD0gMCkge1xuICAgICAgc2l6ZSA9IERFRkFVTFRfQlVGX1NJWkU7XG4gICAgfVxuICAgIHRoaXMuYnVmID0gbmV3IFVpbnQ4QXJyYXkoc2l6ZSk7XG4gIH1cblxuICAvKiogRGlzY2FyZHMgYW55IHVuZmx1c2hlZCBidWZmZXJlZCBkYXRhLCBjbGVhcnMgYW55IGVycm9yLCBhbmRcbiAgICogcmVzZXRzIGJ1ZmZlciB0byB3cml0ZSBpdHMgb3V0cHV0IHRvIHcuXG4gICAqL1xuICByZXNldCh3OiBXcml0ZXJTeW5jKTogdm9pZCB7XG4gICAgdGhpcy5lcnIgPSBudWxsO1xuICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzID0gMDtcbiAgICB0aGlzLndyaXRlciA9IHc7XG4gIH1cblxuICAvKiogRmx1c2ggd3JpdGVzIGFueSBidWZmZXJlZCBkYXRhIHRvIHRoZSB1bmRlcmx5aW5nIGlvLldyaXRlclN5bmMuICovXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmVyciAhPT0gbnVsbCkgdGhyb3cgdGhpcy5lcnI7XG4gICAgaWYgKHRoaXMudXNlZEJ1ZmZlckJ5dGVzID09PSAwKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgRGVuby53cml0ZUFsbFN5bmMoXG4gICAgICAgIHRoaXMud3JpdGVyLFxuICAgICAgICB0aGlzLmJ1Zi5zdWJhcnJheSgwLCB0aGlzLnVzZWRCdWZmZXJCeXRlcyksXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRoaXMuZXJyID0gZTtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuXG4gICAgdGhpcy5idWYgPSBuZXcgVWludDhBcnJheSh0aGlzLmJ1Zi5sZW5ndGgpO1xuICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzID0gMDtcbiAgfVxuXG4gIC8qKiBXcml0ZXMgdGhlIGNvbnRlbnRzIG9mIGBkYXRhYCBpbnRvIHRoZSBidWZmZXIuICBJZiB0aGUgY29udGVudHMgd29uJ3QgZnVsbHlcbiAgICogZml0IGludG8gdGhlIGJ1ZmZlciwgdGhvc2UgYnl0ZXMgdGhhdCBjYW4gYXJlIGNvcGllZCBpbnRvIHRoZSBidWZmZXIsIHRoZVxuICAgKiBidWZmZXIgaXMgdGhlIGZsdXNoZWQgdG8gdGhlIHdyaXRlciBhbmQgdGhlIHJlbWFpbmluZyBieXRlcyBhcmUgY29waWVkIGludG9cbiAgICogdGhlIG5vdyBlbXB0eSBidWZmZXIuXG4gICAqXG4gICAqIEByZXR1cm4gdGhlIG51bWJlciBvZiBieXRlcyB3cml0dGVuIHRvIHRoZSBidWZmZXIuXG4gICAqL1xuICB3cml0ZVN5bmMoZGF0YTogVWludDhBcnJheSk6IG51bWJlciB7XG4gICAgaWYgKHRoaXMuZXJyICE9PSBudWxsKSB0aHJvdyB0aGlzLmVycjtcbiAgICBpZiAoZGF0YS5sZW5ndGggPT09IDApIHJldHVybiAwO1xuXG4gICAgbGV0IHRvdGFsQnl0ZXNXcml0dGVuID0gMDtcbiAgICBsZXQgbnVtQnl0ZXNXcml0dGVuID0gMDtcbiAgICB3aGlsZSAoZGF0YS5ieXRlTGVuZ3RoID4gdGhpcy5hdmFpbGFibGUoKSkge1xuICAgICAgaWYgKHRoaXMuYnVmZmVyZWQoKSA9PT0gMCkge1xuICAgICAgICAvLyBMYXJnZSB3cml0ZSwgZW1wdHkgYnVmZmVyLlxuICAgICAgICAvLyBXcml0ZSBkaXJlY3RseSBmcm9tIGRhdGEgdG8gYXZvaWQgY29weS5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBudW1CeXRlc1dyaXR0ZW4gPSB0aGlzLndyaXRlci53cml0ZVN5bmMoZGF0YSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICB0aGlzLmVyciA9IGU7XG4gICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbnVtQnl0ZXNXcml0dGVuID0gY29weUJ5dGVzKGRhdGEsIHRoaXMuYnVmLCB0aGlzLnVzZWRCdWZmZXJCeXRlcyk7XG4gICAgICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzICs9IG51bUJ5dGVzV3JpdHRlbjtcbiAgICAgICAgdGhpcy5mbHVzaCgpO1xuICAgICAgfVxuICAgICAgdG90YWxCeXRlc1dyaXR0ZW4gKz0gbnVtQnl0ZXNXcml0dGVuO1xuICAgICAgZGF0YSA9IGRhdGEuc3ViYXJyYXkobnVtQnl0ZXNXcml0dGVuKTtcbiAgICB9XG5cbiAgICBudW1CeXRlc1dyaXR0ZW4gPSBjb3B5Qnl0ZXMoZGF0YSwgdGhpcy5idWYsIHRoaXMudXNlZEJ1ZmZlckJ5dGVzKTtcbiAgICB0aGlzLnVzZWRCdWZmZXJCeXRlcyArPSBudW1CeXRlc1dyaXR0ZW47XG4gICAgdG90YWxCeXRlc1dyaXR0ZW4gKz0gbnVtQnl0ZXNXcml0dGVuO1xuICAgIHJldHVybiB0b3RhbEJ5dGVzV3JpdHRlbjtcbiAgfVxufVxuXG4vKiogR2VuZXJhdGUgbG9uZ2VzdCBwcm9wZXIgcHJlZml4IHdoaWNoIGlzIGFsc28gc3VmZml4IGFycmF5LiAqL1xuZnVuY3Rpb24gY3JlYXRlTFBTKHBhdDogVWludDhBcnJheSk6IFVpbnQ4QXJyYXkge1xuICBjb25zdCBscHMgPSBuZXcgVWludDhBcnJheShwYXQubGVuZ3RoKTtcbiAgbHBzWzBdID0gMDtcbiAgbGV0IHByZWZpeEVuZCA9IDA7XG4gIGxldCBpID0gMTtcbiAgd2hpbGUgKGkgPCBscHMubGVuZ3RoKSB7XG4gICAgaWYgKHBhdFtpXSA9PSBwYXRbcHJlZml4RW5kXSkge1xuICAgICAgcHJlZml4RW5kKys7XG4gICAgICBscHNbaV0gPSBwcmVmaXhFbmQ7XG4gICAgICBpKys7XG4gICAgfSBlbHNlIGlmIChwcmVmaXhFbmQgPT09IDApIHtcbiAgICAgIGxwc1tpXSA9IDA7XG4gICAgICBpKys7XG4gICAgfSBlbHNlIHtcbiAgICAgIHByZWZpeEVuZCA9IHBhdFtwcmVmaXhFbmQgLSAxXTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGxwcztcbn1cblxuLyoqIFJlYWQgZGVsaW1pdGVkIGJ5dGVzIGZyb20gYSBSZWFkZXIuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24qIHJlYWREZWxpbShcbiAgcmVhZGVyOiBSZWFkZXIsXG4gIGRlbGltOiBVaW50OEFycmF5LFxuKTogQXN5bmNJdGVyYWJsZUl0ZXJhdG9yPFVpbnQ4QXJyYXk+IHtcbiAgLy8gQXZvaWQgdW5pY29kZSBwcm9ibGVtc1xuICBjb25zdCBkZWxpbUxlbiA9IGRlbGltLmxlbmd0aDtcbiAgY29uc3QgZGVsaW1MUFMgPSBjcmVhdGVMUFMoZGVsaW0pO1xuXG4gIGxldCBpbnB1dEJ1ZmZlciA9IG5ldyBEZW5vLkJ1ZmZlcigpO1xuICBjb25zdCBpbnNwZWN0QXJyID0gbmV3IFVpbnQ4QXJyYXkoTWF0aC5tYXgoMTAyNCwgZGVsaW1MZW4gKyAxKSk7XG5cbiAgLy8gTW9kaWZpZWQgS01QXG4gIGxldCBpbnNwZWN0SW5kZXggPSAwO1xuICBsZXQgbWF0Y2hJbmRleCA9IDA7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVhZGVyLnJlYWQoaW5zcGVjdEFycik7XG4gICAgaWYgKHJlc3VsdCA9PT0gbnVsbCkge1xuICAgICAgLy8gWWllbGQgbGFzdCBjaHVuay5cbiAgICAgIHlpZWxkIGlucHV0QnVmZmVyLmJ5dGVzKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICgocmVzdWx0IGFzIG51bWJlcikgPCAwKSB7XG4gICAgICAvLyBEaXNjYXJkIGFsbCByZW1haW5pbmcgYW5kIHNpbGVudGx5IGZhaWwuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHNsaWNlUmVhZCA9IGluc3BlY3RBcnIuc3ViYXJyYXkoMCwgcmVzdWx0IGFzIG51bWJlcik7XG4gICAgYXdhaXQgRGVuby53cml0ZUFsbChpbnB1dEJ1ZmZlciwgc2xpY2VSZWFkKTtcblxuICAgIGxldCBzbGljZVRvUHJvY2VzcyA9IGlucHV0QnVmZmVyLmJ5dGVzKCk7XG4gICAgd2hpbGUgKGluc3BlY3RJbmRleCA8IHNsaWNlVG9Qcm9jZXNzLmxlbmd0aCkge1xuICAgICAgaWYgKHNsaWNlVG9Qcm9jZXNzW2luc3BlY3RJbmRleF0gPT09IGRlbGltW21hdGNoSW5kZXhdKSB7XG4gICAgICAgIGluc3BlY3RJbmRleCsrO1xuICAgICAgICBtYXRjaEluZGV4Kys7XG4gICAgICAgIGlmIChtYXRjaEluZGV4ID09PSBkZWxpbUxlbikge1xuICAgICAgICAgIC8vIEZ1bGwgbWF0Y2hcbiAgICAgICAgICBjb25zdCBtYXRjaEVuZCA9IGluc3BlY3RJbmRleCAtIGRlbGltTGVuO1xuICAgICAgICAgIGNvbnN0IHJlYWR5Qnl0ZXMgPSBzbGljZVRvUHJvY2Vzcy5zdWJhcnJheSgwLCBtYXRjaEVuZCk7XG4gICAgICAgICAgLy8gQ29weVxuICAgICAgICAgIGNvbnN0IHBlbmRpbmdCeXRlcyA9IHNsaWNlVG9Qcm9jZXNzLnNsaWNlKGluc3BlY3RJbmRleCk7XG4gICAgICAgICAgeWllbGQgcmVhZHlCeXRlcztcbiAgICAgICAgICAvLyBSZXNldCBtYXRjaCwgZGlmZmVyZW50IGZyb20gS01QLlxuICAgICAgICAgIHNsaWNlVG9Qcm9jZXNzID0gcGVuZGluZ0J5dGVzO1xuICAgICAgICAgIGluc3BlY3RJbmRleCA9IDA7XG4gICAgICAgICAgbWF0Y2hJbmRleCA9IDA7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChtYXRjaEluZGV4ID09PSAwKSB7XG4gICAgICAgICAgaW5zcGVjdEluZGV4Kys7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbWF0Y2hJbmRleCA9IGRlbGltTFBTW21hdGNoSW5kZXggLSAxXTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICAvLyBLZWVwIGluc3BlY3RJbmRleCBhbmQgbWF0Y2hJbmRleC5cbiAgICBpbnB1dEJ1ZmZlciA9IG5ldyBEZW5vLkJ1ZmZlcihzbGljZVRvUHJvY2Vzcyk7XG4gIH1cbn1cblxuLyoqIFJlYWQgZGVsaW1pdGVkIHN0cmluZ3MgZnJvbSBhIFJlYWRlci4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiogcmVhZFN0cmluZ0RlbGltKFxuICByZWFkZXI6IFJlYWRlcixcbiAgZGVsaW06IHN0cmluZyxcbik6IEFzeW5jSXRlcmFibGVJdGVyYXRvcjxzdHJpbmc+IHtcbiAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgcmVhZERlbGltKHJlYWRlciwgZW5jb2Rlci5lbmNvZGUoZGVsaW0pKSkge1xuICAgIHlpZWxkIGRlY29kZXIuZGVjb2RlKGNodW5rKTtcbiAgfVxufVxuXG4vKiogUmVhZCBzdHJpbmdzIGxpbmUtYnktbGluZSBmcm9tIGEgUmVhZGVyLiAqL1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIHJlcXVpcmUtYXdhaXRcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiogcmVhZExpbmVzKFxuICByZWFkZXI6IFJlYWRlcixcbik6IEFzeW5jSXRlcmFibGVJdGVyYXRvcjxzdHJpbmc+IHtcbiAgeWllbGQqIHJlYWRTdHJpbmdEZWxpbShyZWFkZXIsIFwiXFxuXCIpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDBFQUEwRTtBQUMxRSx1RUFBdUU7QUFDdkUsc0RBQXNEO0FBQ3RELHFEQUFxRDtBQUNyRCxpREFBaUQ7QUFLakQsU0FBUyxTQUFTLFFBQVEsa0JBQWtCO0FBQzVDLFNBQVMsTUFBTSxRQUFRLHFCQUFxQjtBQUU1QyxNQUFNLG1CQUFtQjtBQUN6QixNQUFNLGVBQWU7QUFDckIsTUFBTSw4QkFBOEI7QUFDcEMsTUFBTSxLQUFLLEtBQUssVUFBVSxDQUFDO0FBQzNCLE1BQU0sS0FBSyxLQUFLLFVBQVUsQ0FBQztBQUUzQixPQUFPLE1BQU0sd0JBQXdCO0lBRWhCO0lBRG5CLEtBQXlCO0lBQ3pCLFlBQW1CLFFBQXFCO1FBQ3RDLEtBQUssQ0FBQzt1QkFEVzthQURuQixPQUFPO0lBR1A7QUFDRixDQUFDO0FBRUQsT0FBTyxNQUFNLHlCQUF5QixLQUFLLE1BQU0sQ0FBQyxhQUFhO0lBQzdELE9BQU8sbUJBQW1CO0lBQzFCLFFBQXFCO0lBQ3JCLGFBQWM7UUFDWixLQUFLLENBQUM7SUFDUjtBQUNGLENBQUM7QUFRRCx3REFBd0QsR0FDeEQsT0FBTyxNQUFNO0lBQ0gsSUFBaUI7SUFDakIsR0FBWTtJQUNaLElBQUksRUFBRTtJQUNOLElBQUksRUFBRTtJQUNOLE1BQU0sS0FBSyxDQUFDO0lBQ3BCLDRCQUE0QjtJQUM1QixnQ0FBZ0M7SUFFaEMsK0NBQStDLEdBQy9DLE9BQU8sT0FBTyxDQUFTLEVBQUUsT0FBZSxnQkFBZ0IsRUFBYTtRQUNuRSxPQUFPLGFBQWEsWUFBWSxJQUFJLElBQUksVUFBVSxHQUFHLEtBQUs7SUFDNUQ7SUFFQSxZQUFZLEVBQVUsRUFBRSxPQUFlLGdCQUFnQixDQUFFO1FBQ3ZELElBQUksT0FBTyxjQUFjO1lBQ3ZCLE9BQU87UUFDVCxDQUFDO1FBQ0QsSUFBSSxDQUFDLE1BQU0s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