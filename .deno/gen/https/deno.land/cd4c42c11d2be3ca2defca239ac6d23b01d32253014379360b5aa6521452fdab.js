// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.
/**
 * pooledMap transforms values from an (async) iterable into another async
 * iterable. The transforms are done concurrently, with a max concurrency
 * defined by the poolLimit.
 * 
 * @param poolLimit The maximum count of items being processed concurrently. 
 * @param array The input array for mapping.
 * @param iteratorFn The function to call for every item of the array.
 */ export function pooledMap(poolLimit, array, iteratorFn) {
    // Create the async iterable that is returned from this function.
    const res = new TransformStream({
        async transform (p, controller) {
            controller.enqueue(await p);
        }
    });
    // Start processing items from the iterator
    (async ()=>{
        const writer = res.writable.getWriter();
        const executing = [];
        for await (const item of array){
            const p = Promise.resolve().then(()=>iteratorFn(item));
            writer.write(p);
            const e = p.then(()=>executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= poolLimit) {
                await Promise.race(executing);
            }
        }
        // Wait until all ongoing events have processed, then close the writer.
        await Promise.all(executing);
        writer.close();
    })();
    return res.readable.getIterator();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vZGVuby5sYW5kL3N0ZEAwLjc1LjAvYXN5bmMvcG9vbC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDIwIHRoZSBEZW5vIGF1dGhvcnMuIEFsbCByaWdodHMgcmVzZXJ2ZWQuIE1JVCBsaWNlbnNlLlxuXG4vKipcbiAqIHBvb2xlZE1hcCB0cmFuc2Zvcm1zIHZhbHVlcyBmcm9tIGFuIChhc3luYykgaXRlcmFibGUgaW50byBhbm90aGVyIGFzeW5jXG4gKiBpdGVyYWJsZS4gVGhlIHRyYW5zZm9ybXMgYXJlIGRvbmUgY29uY3VycmVudGx5LCB3aXRoIGEgbWF4IGNvbmN1cnJlbmN5XG4gKiBkZWZpbmVkIGJ5IHRoZSBwb29sTGltaXQuXG4gKiBcbiAqIEBwYXJhbSBwb29sTGltaXQgVGhlIG1heGltdW0gY291bnQgb2YgaXRlbXMgYmVpbmcgcHJvY2Vzc2VkIGNvbmN1cnJlbnRseS4gXG4gKiBAcGFyYW0gYXJyYXkgVGhlIGlucHV0IGFycmF5IGZvciBtYXBwaW5nLlxuICogQHBhcmFtIGl0ZXJhdG9yRm4gVGhlIGZ1bmN0aW9uIHRvIGNhbGwgZm9yIGV2ZXJ5IGl0ZW0gb2YgdGhlIGFycmF5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcG9vbGVkTWFwPFQsIFI+KFxuICBwb29sTGltaXQ6IG51bWJlcixcbiAgYXJyYXk6IEl0ZXJhYmxlPFQ+IHwgQXN5bmNJdGVyYWJsZTxUPixcbiAgaXRlcmF0b3JGbjogKGRhdGE6IFQpID0+IFByb21pc2U8Uj4sXG4pOiBBc3luY0l0ZXJhYmxlSXRlcmF0b3I8Uj4ge1xuICAvLyBDcmVhdGUgdGhlIGFzeW5jIGl0ZXJhYmxlIHRoYXQgaXMgcmV0dXJuZWQgZnJvbSB0aGlzIGZ1bmN0aW9uLlxuICBjb25zdCByZXMgPSBuZXcgVHJhbnNmb3JtU3RyZWFtPFByb21pc2U8Uj4sIFI+KHtcbiAgICBhc3luYyB0cmFuc2Zvcm0oXG4gICAgICBwOiBQcm9taXNlPFI+LFxuICAgICAgY29udHJvbGxlcjogVHJhbnNmb3JtU3RyZWFtRGVmYXVsdENvbnRyb2xsZXI8Uj4sXG4gICAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICBjb250cm9sbGVyLmVucXVldWUoYXdhaXQgcCk7XG4gICAgfSxcbiAgfSk7XG4gIC8vIFN0YXJ0IHByb2Nlc3NpbmcgaXRlbXMgZnJvbSB0aGUgaXRlcmF0b3JcbiAgKGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBjb25zdCB3cml0ZXIgPSByZXMud3JpdGFibGUuZ2V0V3JpdGVyKCk7XG4gICAgY29uc3QgZXhlY3V0aW5nOiBBcnJheTxQcm9taXNlPHVua25vd24+PiA9IFtdO1xuICAgIGZvciBhd2FpdCAoY29uc3QgaXRlbSBvZiBhcnJheSkge1xuICAgICAgY29uc3QgcCA9IFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gaXRlcmF0b3JGbihpdGVtKSk7XG4gICAgICB3cml0ZXIud3JpdGUocCk7XG4gICAgICBjb25zdCBlOiBQcm9taXNlPHVua25vd24+ID0gcC50aGVuKCgpID0+XG4gICAgICAgIGV4ZWN1dGluZy5zcGxpY2UoZXhlY3V0aW5nLmluZGV4T2YoZSksIDEpXG4gICAgICApO1xuICAgICAgZXhlY3V0aW5nLnB1c2goZSk7XG4gICAgICBpZiAoZXhlY3V0aW5nLmxlbmd0aCA+PSBwb29sTGltaXQpIHtcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5yYWNlKGV4ZWN1dGluZyk7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIFdhaXQgdW50aWwgYWxsIG9uZ29pbmcgZXZlbnRzIGhhdmUgcHJvY2Vzc2VkLCB0aGVuIGNsb3NlIHRoZSB3cml0ZXIuXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoZXhlY3V0aW5nKTtcbiAgICB3cml0ZXIuY2xvc2UoKTtcbiAgfSkoKTtcbiAgcmV0dXJuIHJlcy5yZWFkYWJsZS5nZXRJdGVyYXRvcigpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDBFQUEwRTtBQUUxRTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxVQUNkLFNBQWlCLEVBQ2pCLEtBQXFDLEVBQ3JDLFVBQW1DLEVBQ1Q7SUFDMUIsaUVBQWlFO0lBQ2pFLE1BQU0sTUFBTSxJQUFJLGdCQUErQjtRQUM3QyxNQUFNLFdBQ0osQ0FBYSxFQUNiLFVBQStDLEVBQ2hDO1lBQ2YsV0FBVyxPQUFPLENBQUMsTUFBTTtRQUMzQjtJQUNGO0lBQ0EsMkNBQTJDO0lBQzFDLENBQUEsVUFBMkI7UUFDMUIsTUFBTSxTQUFTLElBQUksUUFBUSxDQUFDLFNBQVM7UUFDckMsTUFBTSxZQUFxQyxFQUFFO1FBQzdDLFdBQVcsTUFBTSxRQUFRLE1BQU87WUFDOUIsTUFBTSxJQUFJLFFBQVEsT0FBTyxHQUFHLElBQUksQ0FBQyxJQUFNLFdBQVc7WUFDbEQsT0FBTyxLQUFLLENBQUM7WUFDYixNQUFNLElBQXNCLEVBQUUsSUFBSSxDQUFDLElBQ2pDLFVBQVUsTUFBTSxDQUFDLFVBQVUsT0FBTyxDQUFDLElBQUk7WUFFekMsVUFBVSxJQUFJLENBQUM7WUFDZixJQUFJLFVBQVUsTUFBTSxJQUFJLFdBQVc7Z0JBQ2pDLE1BQU0sUUFBUSxJQUFJLENBQUM7WUFDckIsQ0FBQztRQUNIO1FBQ0EsdUVBQXVFO1FBQ3ZFLE1BQU0sUUFBUSxHQUFHLENBQUM7UUFDbEIsT0FBTyxLQUFLO0lBQ2QsQ0FBQTtJQUNBLE9BQU8sSUFBSSxRQUFRLENBQUMsV0FBVztBQUNqQyxDQUFDIn0=