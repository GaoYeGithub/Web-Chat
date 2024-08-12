// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
/**
 * Determines whether an object has a property with the specified name.
 * Avoid calling prototype builtin `hasOwnProperty` for two reasons:
 *
 * 1. `hasOwnProperty` is defined on the object as something else:
 *
 *      const options = {
 *        ending: 'utf8',
 *        hasOwnProperty: 'foo'
 *      };
 *      options.hasOwnProperty('ending') // throws a TypeError
 *
 * 2. The object doesn't inherit from `Object.prototype`:
 *
 *       const options = Object.create(null);
 *       options.ending = 'utf8';
 *       options.hasOwnProperty('ending'); // throws a TypeError
 *
 * @param obj A Object.
 * @param v A property name.
 * @see https://eslint.org/docs/rules/no-prototype-builtins
 */ export function hasOwnProperty(obj, v) {
    if (obj == null) {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(obj, v);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvX3V0aWwvaGFzX293bl9wcm9wZXJ0eS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDIwIHRoZSBEZW5vIGF1dGhvcnMuIEFsbCByaWdodHMgcmVzZXJ2ZWQuIE1JVCBsaWNlbnNlLlxuXG4vKipcbiAqIERldGVybWluZXMgd2hldGhlciBhbiBvYmplY3QgaGFzIGEgcHJvcGVydHkgd2l0aCB0aGUgc3BlY2lmaWVkIG5hbWUuXG4gKiBBdm9pZCBjYWxsaW5nIHByb3RvdHlwZSBidWlsdGluIGBoYXNPd25Qcm9wZXJ0eWAgZm9yIHR3byByZWFzb25zOlxuICpcbiAqIDEuIGBoYXNPd25Qcm9wZXJ0eWAgaXMgZGVmaW5lZCBvbiB0aGUgb2JqZWN0IGFzIHNvbWV0aGluZyBlbHNlOlxuICpcbiAqICAgICAgY29uc3Qgb3B0aW9ucyA9IHtcbiAqICAgICAgICBlbmRpbmc6ICd1dGY4JyxcbiAqICAgICAgICBoYXNPd25Qcm9wZXJ0eTogJ2ZvbydcbiAqICAgICAgfTtcbiAqICAgICAgb3B0aW9ucy5oYXNPd25Qcm9wZXJ0eSgnZW5kaW5nJykgLy8gdGhyb3dzIGEgVHlwZUVycm9yXG4gKlxuICogMi4gVGhlIG9iamVjdCBkb2Vzbid0IGluaGVyaXQgZnJvbSBgT2JqZWN0LnByb3RvdHlwZWA6XG4gKlxuICogICAgICAgY29uc3Qgb3B0aW9ucyA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG4gKiAgICAgICBvcHRpb25zLmVuZGluZyA9ICd1dGY4JztcbiAqICAgICAgIG9wdGlvbnMuaGFzT3duUHJvcGVydHkoJ2VuZGluZycpOyAvLyB0aHJvd3MgYSBUeXBlRXJyb3JcbiAqXG4gKiBAcGFyYW0gb2JqIEEgT2JqZWN0LlxuICogQHBhcmFtIHYgQSBwcm9wZXJ0eSBuYW1lLlxuICogQHNlZSBodHRwczovL2VzbGludC5vcmcvZG9jcy9ydWxlcy9uby1wcm90b3R5cGUtYnVpbHRpbnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc093blByb3BlcnR5PFQ+KG9iajogVCwgdjogUHJvcGVydHlLZXkpOiBib29sZWFuIHtcbiAgaWYgKG9iaiA9PSBudWxsKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCB2KTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwRUFBMEU7QUFFMUU7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXFCQyxHQUNELE9BQU8sU0FBUyxlQUFrQixHQUFNLEVBQUUsQ0FBYyxFQUFXO0lBQ2pFLElBQUksT0FBTyxJQUFJLEVBQUU7UUFDZixPQUFPLEtBQUs7SUFDZCxDQUFDO0lBQ0QsT0FBTyxPQUFPLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEtBQUs7QUFDbkQsQ0FBQyJ9