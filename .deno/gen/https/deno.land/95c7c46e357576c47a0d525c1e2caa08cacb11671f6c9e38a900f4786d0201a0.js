// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
// TODO(ry) It'd be better to make Deferred a class that inherits from
// Promise, rather than an interface. This is possible in ES2016, however
// typescript produces broken code when targeting ES5 code.
// See https://github.com/Microsoft/TypeScript/issues/15202
// At the time of writing, the github issue is closed but the problem remains.
/** Creates a Promise with the `reject` and `resolve` functions
 * placed as methods on the promise object itself. It allows you to do:
 *
 *     const p = deferred<number>();
 *     // ...
 *     p.resolve(42);
 */ export function deferred() {
    let methods;
    const promise = new Promise((resolve, reject)=>{
        methods = {
            resolve,
            reject
        };
    });
    return Object.assign(promise, methods);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvYXN5bmMvZGVmZXJyZWQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyMCB0aGUgRGVubyBhdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLiBNSVQgbGljZW5zZS5cbi8vIFRPRE8ocnkpIEl0J2QgYmUgYmV0dGVyIHRvIG1ha2UgRGVmZXJyZWQgYSBjbGFzcyB0aGF0IGluaGVyaXRzIGZyb21cbi8vIFByb21pc2UsIHJhdGhlciB0aGFuIGFuIGludGVyZmFjZS4gVGhpcyBpcyBwb3NzaWJsZSBpbiBFUzIwMTYsIGhvd2V2ZXJcbi8vIHR5cGVzY3JpcHQgcHJvZHVjZXMgYnJva2VuIGNvZGUgd2hlbiB0YXJnZXRpbmcgRVM1IGNvZGUuXG4vLyBTZWUgaHR0cHM6Ly9naXRodWIuY29tL01pY3Jvc29mdC9UeXBlU2NyaXB0L2lzc3Vlcy8xNTIwMlxuLy8gQXQgdGhlIHRpbWUgb2Ygd3JpdGluZywgdGhlIGdpdGh1YiBpc3N1ZSBpcyBjbG9zZWQgYnV0IHRoZSBwcm9ibGVtIHJlbWFpbnMuXG5leHBvcnQgaW50ZXJmYWNlIERlZmVycmVkPFQ+IGV4dGVuZHMgUHJvbWlzZTxUPiB7XG4gIHJlc29sdmU6ICh2YWx1ZT86IFQgfCBQcm9taXNlTGlrZTxUPikgPT4gdm9pZDtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgcmVqZWN0OiAocmVhc29uPzogYW55KSA9PiB2b2lkO1xufVxuXG4vKiogQ3JlYXRlcyBhIFByb21pc2Ugd2l0aCB0aGUgYHJlamVjdGAgYW5kIGByZXNvbHZlYCBmdW5jdGlvbnNcbiAqIHBsYWNlZCBhcyBtZXRob2RzIG9uIHRoZSBwcm9taXNlIG9iamVjdCBpdHNlbGYuIEl0IGFsbG93cyB5b3UgdG8gZG86XG4gKlxuICogICAgIGNvbnN0IHAgPSBkZWZlcnJlZDxudW1iZXI+KCk7XG4gKiAgICAgLy8gLi4uXG4gKiAgICAgcC5yZXNvbHZlKDQyKTtcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZmVycmVkPFQ+KCk6IERlZmVycmVkPFQ+IHtcbiAgbGV0IG1ldGhvZHM7XG4gIGNvbnN0IHByb21pc2UgPSBuZXcgUHJvbWlzZTxUPigocmVzb2x2ZSwgcmVqZWN0KTogdm9pZCA9PiB7XG4gICAgbWV0aG9kcyA9IHsgcmVzb2x2ZSwgcmVqZWN0IH07XG4gIH0pO1xuICByZXR1cm4gT2JqZWN0LmFzc2lnbihwcm9taXNlLCBtZXRob2RzKSBhcyBEZWZlcnJlZDxUPjtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwRUFBMEU7QUFDMUUsc0VBQXNFO0FBQ3RFLHlFQUF5RTtBQUN6RSwyREFBMkQ7QUFDM0QsMkRBQTJEO0FBQzNELDhFQUE4RTtBQU85RTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsV0FBMkI7SUFDekMsSUFBSTtJQUNKLE1BQU0sVUFBVSxJQUFJLFFBQVcsQ0FBQyxTQUFTLFNBQWlCO1FBQ3hELFVBQVU7WUFBRTtZQUFTO1FBQU87SUFDOUI7SUFDQSxPQUFPLE9BQU8sTUFBTSxDQUFDLFNBQVM7QUFDaEMsQ0FBQyJ9