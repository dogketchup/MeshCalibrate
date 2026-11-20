// OpenCV for the Node backend: the WebAssembly build of OpenCV (@techstark/opencv-js).
//
// Two traps, both avoided here:
//  - the module object is a "thenable" whose then() hands back the module itself, so `await`ing it
//    (or resolving a Promise with it) loops forever - it is returned wrapped as { cv };
//  - it finishes initialising asynchronously without holding Node's event loop open, so readiness
//    is polled with a timer (which keeps the process alive until it is ready).
import { createRequire } from 'node:module';

let ready = null;

export function loadCv(timeoutMs = 60000) {
  if (!ready) {
    ready = new Promise((resolve, reject) => {
      const cv = createRequire(import.meta.url)('@techstark/opencv-js');
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (cv.Mat) {
          clearInterval(iv);
          resolve({ cv, loadMs: Date.now() - t0 });
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv);
          reject(new Error('OpenCV (opencv.js) did not finish loading'));
        }
      }, 10);
    });
  }
  return ready;
}
