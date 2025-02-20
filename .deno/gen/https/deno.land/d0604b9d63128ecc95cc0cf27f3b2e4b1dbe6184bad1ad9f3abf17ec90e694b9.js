// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
export class DenoStdInternalError extends Error {
    constructor(message){
        super(message);
        this.name = "DenoStdInternalError";
    }
}
/** Make an assertion, if not `true`, then throw. */ export function assert(expr, msg = "") {
    if (!expr) {
        throw new DenoStdInternalError(msg);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvX3V0aWwvYXNzZXJ0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCAyMDE4LTIwMjAgdGhlIERlbm8gYXV0aG9ycy4gQWxsIHJpZ2h0cyByZXNlcnZlZC4gTUlUIGxpY2Vuc2UuXG5cbmV4cG9ydCBjbGFzcyBEZW5vU3RkSW50ZXJuYWxFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJEZW5vU3RkSW50ZXJuYWxFcnJvclwiO1xuICB9XG59XG5cbi8qKiBNYWtlIGFuIGFzc2VydGlvbiwgaWYgbm90IGB0cnVlYCwgdGhlbiB0aHJvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnQoZXhwcjogdW5rbm93biwgbXNnID0gXCJcIik6IGFzc2VydHMgZXhwciB7XG4gIGlmICghZXhwcikge1xuICAgIHRocm93IG5ldyBEZW5vU3RkSW50ZXJuYWxFcnJvcihtc2cpO1xuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsMEVBQTBFO0FBRTFFLE9BQU8sTUFBTSw2QkFBNkI7SUFDeEMsWUFBWSxPQUFlLENBQUU7UUFDM0IsS0FBSyxDQUFDO1FBQ04sSUFBSSxDQUFDLElBQUksR0FBRztJQUNkO0FBQ0YsQ0FBQztBQUVELGtEQUFrRCxHQUNsRCxPQUFPLFNBQVMsT0FBTyxJQUFhLEVBQUUsTUFBTSxFQUFFLEVBQWdCO0lBQzVELElBQUksQ0FBQyxNQUFNO1FBQ1QsTUFBTSxJQUFJLHFCQUFxQixLQUFLO0lBQ3RDLENBQUM7QUFDSCxDQUFDIn0=