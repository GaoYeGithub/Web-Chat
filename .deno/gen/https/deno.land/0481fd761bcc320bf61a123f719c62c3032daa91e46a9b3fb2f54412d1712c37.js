// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
/** Find first index of binary pattern from a. If not found, then return -1
 * @param source source array
 * @param pat pattern to find in source array
 */ export function findIndex(source, pat) {
    const s = pat[0];
    for(let i = 0; i < source.length; i++){
        if (source[i] !== s) continue;
        const pin = i;
        let matched = 1;
        let j = i;
        while(matched < pat.length){
            j++;
            if (source[j] !== pat[j - pin]) {
                break;
            }
            matched++;
        }
        if (matched === pat.length) {
            return pin;
        }
    }
    return -1;
}
/** Find last index of binary pattern from a. If not found, then return -1.
 * @param source source array
 * @param pat pattern to find in source array
 */ export function findLastIndex(source, pat) {
    const e = pat[pat.length - 1];
    for(let i = source.length - 1; i >= 0; i--){
        if (source[i] !== e) continue;
        const pin = i;
        let matched = 1;
        let j = i;
        while(matched < pat.length){
            j--;
            if (source[j] !== pat[pat.length - 1 - (pin - j)]) {
                break;
            }
            matched++;
        }
        if (matched === pat.length) {
            return pin - pat.length + 1;
        }
    }
    return -1;
}
/** Check whether binary arrays are equal to each other.
 * @param source first array to check equality
 * @param match second array to check equality
 */ export function equal(source, match) {
    if (source.length !== match.length) return false;
    for(let i = 0; i < match.length; i++){
        if (source[i] !== match[i]) return false;
    }
    return true;
}
/** Check whether binary array starts with prefix.
 * @param source srouce array
 * @param prefix prefix array to check in source
 */ export function hasPrefix(source, prefix) {
    for(let i = 0, max = prefix.length; i < max; i++){
        if (source[i] !== prefix[i]) return false;
    }
    return true;
}
/** Check whether binary array ends with suffix.
 * @param source source array
 * @param suffix suffix array to check in source
 */ export function hasSuffix(source, suffix) {
    for(let srci = source.length - 1, sfxi = suffix.length - 1; sfxi >= 0; srci--, sfxi--){
        if (source[srci] !== suffix[sfxi]) return false;
    }
    return true;
}
/** Repeat bytes. returns a new byte slice consisting of `count` copies of `b`.
 * @param origin The origin bytes
 * @param count The count you want to repeat.
 */ export function repeat(origin, count) {
    if (count === 0) {
        return new Uint8Array();
    }
    if (count < 0) {
        throw new Error("bytes: negative repeat count");
    } else if (origin.length * count / count !== origin.length) {
        throw new Error("bytes: repeat count causes overflow");
    }
    const int = Math.floor(count);
    if (int !== count) {
        throw new Error("bytes: repeat count must be an integer");
    }
    const nb = new Uint8Array(origin.length * count);
    let bp = copyBytes(origin, nb);
    for(; bp < nb.length; bp *= 2){
        copyBytes(nb.slice(0, bp), nb, bp);
    }
    return nb;
}
/** Concatenate two binary arrays and return new one.
 * @param origin origin array to concatenate
 * @param b array to concatenate with origin
 */ export function concat(origin, b) {
    const output = new Uint8Array(origin.length + b.length);
    output.set(origin, 0);
    output.set(b, origin.length);
    return output;
}
/** Check source array contains pattern array.
 * @param source source array
 * @param pat patter array
 */ export function contains(source, pat) {
    return findIndex(source, pat) != -1;
}
/**
 * Copy bytes from one Uint8Array to another.  Bytes from `src` which don't fit
 * into `dst` will not be copied.
 *
 * @param src Source byte array
 * @param dst Destination byte array
 * @param off Offset into `dst` at which to begin writing values from `src`.
 * @return number of bytes copied
 */ export function copyBytes(src, dst, off = 0) {
    off = Math.max(0, Math.min(off, dst.byteLength));
    const dstBytesAvailable = dst.byteLength - off;
    if (src.byteLength > dstBytesAvailable) {
        src = src.subarray(0, dstBytesAvailable);
    }
    dst.set(src, off);
    return src.byteLength;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvYnl0ZXMvbW9kLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjAgdGhlIERlbm8gYXV0aG9ycy4gQWxsIHJpZ2h0cyByZXNlcnZlZC4gTUlUIGxpY2Vuc2UuXG5cbi8qKiBGaW5kIGZpcnN0IGluZGV4IG9mIGJpbmFyeSBwYXR0ZXJuIGZyb20gYS4gSWYgbm90IGZvdW5kLCB0aGVuIHJldHVybiAtMVxuICogQHBhcmFtIHNvdXJjZSBzb3VyY2UgYXJyYXlcbiAqIEBwYXJhbSBwYXQgcGF0dGVybiB0byBmaW5kIGluIHNvdXJjZSBhcnJheVxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZEluZGV4KHNvdXJjZTogVWludDhBcnJheSwgcGF0OiBVaW50OEFycmF5KTogbnVtYmVyIHtcbiAgY29uc3QgcyA9IHBhdFswXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzb3VyY2UubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoc291cmNlW2ldICE9PSBzKSBjb250aW51ZTtcbiAgICBjb25zdCBwaW4gPSBpO1xuICAgIGxldCBtYXRjaGVkID0gMTtcbiAgICBsZXQgaiA9IGk7XG4gICAgd2hpbGUgKG1hdGNoZWQgPCBwYXQubGVuZ3RoKSB7XG4gICAgICBqKys7XG4gICAgICBpZiAoc291cmNlW2pdICE9PSBwYXRbaiAtIHBpbl0pIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBtYXRjaGVkKys7XG4gICAgfVxuICAgIGlmIChtYXRjaGVkID09PSBwYXQubGVuZ3RoKSB7XG4gICAgICByZXR1cm4gcGluO1xuICAgIH1cbiAgfVxuICByZXR1cm4gLTE7XG59XG5cbi8qKiBGaW5kIGxhc3QgaW5kZXggb2YgYmluYXJ5IHBhdHRlcm4gZnJvbSBhLiBJZiBub3QgZm91bmQsIHRoZW4gcmV0dXJuIC0xLlxuICogQHBhcmFtIHNvdXJjZSBzb3VyY2UgYXJyYXlcbiAqIEBwYXJhbSBwYXQgcGF0dGVybiB0byBmaW5kIGluIHNvdXJjZSBhcnJheVxuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZExhc3RJbmRleChzb3VyY2U6IFVpbnQ4QXJyYXksIHBhdDogVWludDhBcnJheSk6IG51bWJlciB7XG4gIGNvbnN0IGUgPSBwYXRbcGF0Lmxlbmd0aCAtIDFdO1xuICBmb3IgKGxldCBpID0gc291cmNlLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgaWYgKHNvdXJjZVtpXSAhPT0gZSkgY29udGludWU7XG4gICAgY29uc3QgcGluID0gaTtcbiAgICBsZXQgbWF0Y2hlZCA9IDE7XG4gICAgbGV0IGogPSBpO1xuICAgIHdoaWxlIChtYXRjaGVkIDwgcGF0Lmxlbmd0aCkge1xuICAgICAgai0tO1xuICAgICAgaWYgKHNvdXJjZVtqXSAhPT0gcGF0W3BhdC5sZW5ndGggLSAxIC0gKHBpbiAtIGopXSkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIG1hdGNoZWQrKztcbiAgICB9XG4gICAgaWYgKG1hdGNoZWQgPT09IHBhdC5sZW5ndGgpIHtcbiAgICAgIHJldHVybiBwaW4gLSBwYXQubGVuZ3RoICsgMTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIC0xO1xufVxuXG4vKiogQ2hlY2sgd2hldGhlciBiaW5hcnkgYXJyYXlzIGFyZSBlcXVhbCB0byBlYWNoIG90aGVyLlxuICogQHBhcmFtIHNvdXJjZSBmaXJzdCBhcnJheSB0byBjaGVjayBlcXVhbGl0eVxuICogQHBhcmFtIG1hdGNoIHNlY29uZCBhcnJheSB0byBjaGVjayBlcXVhbGl0eVxuICovXG5leHBvcnQgZnVuY3Rpb24gZXF1YWwoc291cmNlOiBVaW50OEFycmF5LCBtYXRjaDogVWludDhBcnJheSk6IGJvb2xlYW4ge1xuICBpZiAoc291cmNlLmxlbmd0aCAhPT0gbWF0Y2gubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbWF0Y2gubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoc291cmNlW2ldICE9PSBtYXRjaFtpXSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogQ2hlY2sgd2hldGhlciBiaW5hcnkgYXJyYXkgc3RhcnRzIHdpdGggcHJlZml4LlxuICogQHBhcmFtIHNvdXJjZSBzcm91Y2UgYXJyYXlcbiAqIEBwYXJhbSBwcmVmaXggcHJlZml4IGFycmF5IHRvIGNoZWNrIGluIHNvdXJjZVxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzUHJlZml4KHNvdXJjZTogVWludDhBcnJheSwgcHJlZml4OiBVaW50OEFycmF5KTogYm9vbGVhbiB7XG4gIGZvciAobGV0IGkgPSAwLCBtYXggPSBwcmVmaXgubGVuZ3RoOyBpIDwgbWF4OyBpKyspIHtcbiAgICBpZiAoc291cmNlW2ldICE9PSBwcmVmaXhbaV0pIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIENoZWNrIHdoZXRoZXIgYmluYXJ5IGFycmF5IGVuZHMgd2l0aCBzdWZmaXguXG4gKiBAcGFyYW0gc291cmNlIHNvdXJjZSBhcnJheVxuICogQHBhcmFtIHN1ZmZpeCBzdWZmaXggYXJyYXkgdG8gY2hlY2sgaW4gc291cmNlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNTdWZmaXgoc291cmNlOiBVaW50OEFycmF5LCBzdWZmaXg6IFVpbnQ4QXJyYXkpOiBib29sZWFuIHtcbiAgZm9yIChcbiAgICBsZXQgc3JjaSA9IHNvdXJjZS5sZW5ndGggLSAxLCBzZnhpID0gc3VmZml4Lmxlbmd0aCAtIDE7XG4gICAgc2Z4aSA+PSAwO1xuICAgIHNyY2ktLSwgc2Z4aS0tXG4gICkge1xuICAgIGlmIChzb3VyY2Vbc3JjaV0gIT09IHN1ZmZpeFtzZnhpXSkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogUmVwZWF0IGJ5dGVzLiByZXR1cm5zIGEgbmV3IGJ5dGUgc2xpY2UgY29uc2lzdGluZyBvZiBgY291bnRgIGNvcGllcyBvZiBgYmAuXG4gKiBAcGFyYW0gb3JpZ2luIFRoZSBvcmlnaW4gYnl0ZXNcbiAqIEBwYXJhbSBjb3VudCBUaGUgY291bnQgeW91IHdhbnQgdG8gcmVwZWF0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwZWF0KG9yaWdpbjogVWludDhBcnJheSwgY291bnQ6IG51bWJlcik6IFVpbnQ4QXJyYXkge1xuICBpZiAoY291bnQgPT09IDApIHtcbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoKTtcbiAgfVxuXG4gIGlmIChjb3VudCA8IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJieXRlczogbmVnYXRpdmUgcmVwZWF0IGNvdW50XCIpO1xuICB9IGVsc2UgaWYgKChvcmlnaW4ubGVuZ3RoICogY291bnQpIC8gY291bnQgIT09IG9yaWdpbi5sZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJieXRlczogcmVwZWF0IGNvdW50IGNhdXNlcyBvdmVyZmxvd1wiKTtcbiAgfVxuXG4gIGNvbnN0IGludCA9IE1hdGguZmxvb3IoY291bnQpO1xuXG4gIGlmIChpbnQgIT09IGNvdW50KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiYnl0ZXM6IHJlcGVhdCBjb3VudCBtdXN0IGJlIGFuIGludGVnZXJcIik7XG4gIH1cblxuICBjb25zdCBuYiA9IG5ldyBVaW50OEFycmF5KG9yaWdpbi5sZW5ndGggKiBjb3VudCk7XG5cbiAgbGV0IGJwID0gY29weUJ5dGVzKG9yaWdpbiwgbmIpO1xuXG4gIGZvciAoOyBicCA8IG5iLmxlbmd0aDsgYnAgKj0gMikge1xuICAgIGNvcHlCeXRlcyhuYi5zbGljZSgwLCBicCksIG5iLCBicCk7XG4gIH1cblxuICByZXR1cm4gbmI7XG59XG5cbi8qKiBDb25jYXRlbmF0ZSB0d28gYmluYXJ5IGFycmF5cyBhbmQgcmV0dXJuIG5ldyBvbmUuXG4gKiBAcGFyYW0gb3JpZ2luIG9yaWdpbiBhcnJheSB0byBjb25jYXRlbmF0ZVxuICogQHBhcmFtIGIgYXJyYXkgdG8gY29uY2F0ZW5hdGUgd2l0aCBvcmlnaW5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbmNhdChvcmlnaW46IFVpbnQ4QXJyYXksIGI6IFVpbnQ4QXJyYXkpOiBVaW50OEFycmF5IHtcbiAgY29uc3Qgb3V0cHV0ID0gbmV3IFVpbnQ4QXJyYXkob3JpZ2luLmxlbmd0aCArIGIubGVuZ3RoKTtcbiAgb3V0cHV0LnNldChvcmlnaW4sIDApO1xuICBvdXRwdXQuc2V0KGIsIG9yaWdpbi5sZW5ndGgpO1xuICByZXR1cm4gb3V0cHV0O1xufVxuXG4vKiogQ2hlY2sgc291cmNlIGFycmF5IGNvbnRhaW5zIHBhdHRlcm4gYXJyYXkuXG4gKiBAcGFyYW0gc291cmNlIHNvdXJjZSBhcnJheVxuICogQHBhcmFtIHBhdCBwYXR0ZXIgYXJyYXlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnRhaW5zKHNvdXJjZTogVWludDhBcnJheSwgcGF0OiBVaW50OEFycmF5KTogYm9vbGVhbiB7XG4gIHJldHVybiBmaW5kSW5kZXgoc291cmNlLCBwYXQpICE9IC0xO1xufVxuXG4vKipcbiAqIENvcHkgYnl0ZXMgZnJvbSBvbmUgVWludDhBcnJheSB0byBhbm90aGVyLiAgQnl0ZXMgZnJvbSBgc3JjYCB3aGljaCBkb24ndCBmaXRcbiAqIGludG8gYGRzdGAgd2lsbCBub3QgYmUgY29waWVkLlxuICpcbiAqIEBwYXJhbSBzcmMgU291cmNlIGJ5dGUgYXJyYXlcbiAqIEBwYXJhbSBkc3QgRGVzdGluYXRpb24gYnl0ZSBhcnJheVxuICogQHBhcmFtIG9mZiBPZmZzZXQgaW50byBgZHN0YCBhdCB3aGljaCB0byBiZWdpbiB3cml0aW5nIHZhbHVlcyBmcm9tIGBzcmNgLlxuICogQHJldHVybiBudW1iZXIgb2YgYnl0ZXMgY29waWVkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb3B5Qnl0ZXMoc3JjOiBVaW50OEFycmF5LCBkc3Q6IFVpbnQ4QXJyYXksIG9mZiA9IDApOiBudW1iZXIge1xuICBvZmYgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihvZmYsIGRzdC5ieXRlTGVuZ3RoKSk7XG4gIGNvbnN0IGRzdEJ5dGVzQXZhaWxhYmxlID0gZHN0LmJ5dGVMZW5ndGggLSBvZmY7XG4gIGlmIChzcmMuYnl0ZUxlbmd0aCA+IGRzdEJ5dGVzQXZhaWxhYmxlKSB7XG4gICAgc3JjID0gc3JjLnN1YmFycmF5KDAsIGRzdEJ5dGVzQXZhaWxhYmxlKTtcbiAgfVxuICBkc3Quc2V0KHNyYywgb2ZmKTtcbiAgcmV0dXJuIHNyYy5ieXRlTGVuZ3RoO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDBFQUEwRTtBQUUxRTs7O0NBR0MsR0FDRCxPQUFPLFNBQVMsVUFBVSxNQUFrQixFQUFFLEdBQWUsRUFBVTtJQUNyRSxNQUFNLElBQUksR0FBRyxDQUFDLEVBQUU7SUFDaEIsSUFBSyxJQUFJLElBQUksR0FBRyxJQUFJLE9BQU8sTUFBTSxFQUFFLElBQUs7UUFDdEMsSUFBSSxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUcsUUFBUztRQUM5QixNQUFNLE1BQU07UUFDWixJQUFJLFVBQVU7UUFDZCxJQUFJLElBQUk7UUFDUixNQUFPLFVBQVUsSUFBSSxNQUFNLENBQUU7WUFDM0I7WUFDQSxJQUFJLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRyxDQUFDLElBQUksSUFBSSxFQUFFO2dCQUM5QixLQUFNO1lBQ1IsQ0FBQztZQUNEO1FBQ0Y7UUFDQSxJQUFJLFlBQVksSUFBSSxNQUFNLEVBQUU7WUFDMUIsT0FBTztRQUNULENBQUM7SUFDSDtJQUNBLE9BQU8sQ0FBQztBQUNWLENBQUM7QUFFRDs7O0NBR0MsR0FDRCxPQUFPLFNBQVMsY0FBYyxNQUFrQixFQUFFLEdBQWUsRUFBVTtJQUN6RSxNQUFNLElBQUksR0FBRyxDQUFDLElBQUksTUFBTSxHQUFHLEVBQUU7SUFDN0IsSUFBSyxJQUFJLElBQUksT0FBTyxNQUFNLEdBQUcsR0FBRyxLQUFLLEdBQUcsSUFBSztRQUMzQyxJQUFJLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRyxRQUFTO1FBQzlCLE1BQU0sTUFBTTtRQUNaLElBQUksVUFBVTtRQUNkLElB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