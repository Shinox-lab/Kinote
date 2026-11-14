// Relays GridCraft's page-host events to the framing console and back.
//
// GridCraft's `?host=parent` bridge only answers a same-origin parent, but the
// console frames the editor with sandbox="allow-scripts": an opaque origin, so
// the editor stays away from the console's storage (the bearer token). In page
// host mode (`data-host="page"` on the canvas) the editor talks through DOM
// events on the canvas instead, and this script, which shares the editor's
// document, carries those events over postMessage. It keeps the message shape
// the console already speaks: `gridcraft:ready|dirty|save|failed` out and
// `gridcraft:open` in.
//
// It runs before the editor's module (module scripts are deferred), so the
// listeners exist when the editor announces itself.
(function () {
  'use strict';
  var canvas = document.getElementById('gridcraft_canvas');
  var host = window.parent;
  // Not framed: nothing to relay to, and the editor runs on its own.
  if (!canvas || host === window) return;

  function toBuffer(bytes) {
    if (bytes instanceof ArrayBuffer) return bytes;
    if (ArrayBuffer.isView(bytes)) {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return null;
  }

  ['ready', 'dirty', 'save', 'failed'].forEach(function (name) {
    canvas.addEventListener('gridcraft:' + name, function (event) {
      var message = { type: 'gridcraft:' + name };
      var detail = event.detail || {};
      for (var key in detail) {
        if (key !== 'bytes' && Object.prototype.hasOwnProperty.call(detail, key)) message[key] = detail[key];
      }
      var transfer = [];
      if (name === 'save') {
        var bytes = toBuffer(detail.bytes);
        if (!bytes) return;
        message.bytes = bytes;
        transfer.push(bytes);
      }
      // The sandbox has no usable origin to name; frame-ancestors 'self' means
      // the only window that can be the parent is the console.
      host.postMessage(message, '*', transfer);
    });
  });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== host || !data || data.type !== 'gridcraft:open') return;
    var bytes = toBuffer(data.bytes);
    if (typeof data.name !== 'string' || !bytes) return;
    canvas.dispatchEvent(new CustomEvent('gridcraft:open', { detail: { name: data.name, bytes: bytes } }));
  });
})();
