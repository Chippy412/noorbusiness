// js/photo.js
// Prepares listing photos for upload: validates the file, scales it down so the
// longest edge is at most MAX_EDGE, and re-encodes it as WebP (or JPEG).
// Drawing onto a canvas and re-encoding drops all EXIF metadata, including GPS
// location, so nothing private leaves the browser.
// fitWithin / extFor / checkInput are pure and unit-tested; prepare() needs a browser.
(function () {
  "use strict";

  var MAX_EDGE = 1600;
  var MIN_EDGE = 200;
  var MAX_INPUT_BYTES = 20 * 1024 * 1024;
  var MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // the business-photos bucket limit
  var ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
  var READ_ERROR = "We couldn't read that image. Please try a JPG or PNG.";

  // Scale down (never up) so the longest edge is <= maxEdge. Integers, min 1.
  function fitWithin(width, height, maxEdge) {
    var w = Number(width), h = Number(height);
    var longest = Math.max(w, h);
    if (!(longest > maxEdge)) {
      return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
    }
    var scale = maxEdge / longest;
    return {
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale))
    };
  }

  function extFor(mimeType) {
    if (mimeType === "image/webp") return "webp";
    if (mimeType === "image/png") return "png";
    return "jpg";
  }

  // null when the file is acceptable, otherwise a friendly message.
  function checkInput(file) {
    if (!file) return "Please choose a photo.";
    var type = String(file.type || "").toLowerCase();
    if (type === "image/heic" || type === "image/heif") {
      // Browsers can't reliably decode HEIC, so ask for a JPG instead.
      return "HEIC photos aren't supported yet. Please choose a JPG or PNG (on iPhone: Settings > Camera > Formats > Most Compatible).";
    }
    if (ACCEPTED.indexOf(type) === -1) return "Please choose a JPG, PNG or WebP image.";
    if (file.size > MAX_INPUT_BYTES) return "That photo is over 20 MB. Please choose a smaller one.";
    return null;
  }

  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, close: function () {} });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error(READ_ERROR));
      };
      img.src = url;
    });
  }

  async function decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        var bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { source: bmp, width: bmp.width, height: bmp.height, close: function () { if (bmp.close) bmp.close(); } };
      } catch (e) { /* fall back to <img> below */ }
    }
    return loadViaImg(file);
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
  }

  async function prepare(file) {
    var problem = checkInput(file);
    if (problem) throw new Error(problem);

    var img;
    try { img = await decode(file); }
    catch (e) { throw new Error(READ_ERROR); }

    try {
      if (!img.width || !img.height) throw new Error(READ_ERROR);
      if (Math.max(img.width, img.height) < MIN_EDGE) {
        throw new Error("That image is very small. Please use one at least 600 pixels wide.");
      }
      var size = fitWithin(img.width, img.height, MAX_EDGE);
      var canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      var ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(READ_ERROR);
      ctx.drawImage(img.source, 0, 0, size.width, size.height);

      var qualities = [0.85, 0.7, 0.55];
      var type = "image/webp";
      var blob = null;
      for (var i = 0; i < qualities.length; i++) {
        blob = await toBlob(canvas, type, qualities[i]);
        if (type === "image/webp" && (!blob || blob.type !== "image/webp")) {
          // This browser can't encode WebP; use JPEG, on a white background so
          // transparent PNGs don't turn black.
          type = "image/jpeg";
          ctx.globalCompositeOperation = "destination-over";
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, size.width, size.height);
          blob = await toBlob(canvas, type, qualities[i]);
        }
        if (!blob) throw new Error(READ_ERROR);
        if (blob.size <= MAX_OUTPUT_BYTES) {
          return { blob: blob, type: blob.type || type, ext: extFor(blob.type || type), width: size.width, height: size.height };
        }
      }
      throw new Error("That photo is still too large after resizing. Please choose a smaller or simpler image.");
    } finally {
      img.close();
    }
  }

  var api = {
    MAX_EDGE: MAX_EDGE,
    MAX_INPUT_BYTES: MAX_INPUT_BYTES,
    MAX_OUTPUT_BYTES: MAX_OUTPUT_BYTES,
    fitWithin: fitWithin,
    extFor: extFor,
    checkInput: checkInput,
    prepare: prepare
  };
  if (typeof window !== "undefined") window.NiccPhoto = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
