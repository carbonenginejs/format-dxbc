/**
 * Returns a byte view for supported binary inputs without copying when possible.
 *
 * @param {ArrayBuffer|ArrayBufferView|Uint8Array} value Binary payload to normalize.
 * @returns {Uint8Array} Byte view over the supplied payload.
 */
export function cjsNormalizeBytes(value) 
{
    if (value instanceof Uint8Array) 
    {
        return value;
    }
    if (value instanceof ArrayBuffer) 
    {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) 
    {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError("Expected an ArrayBuffer or Uint8Array");
}

/**
 * Reinterprets a little-endian uint32 annotation payload as a float32.
 *
 * @param {number} value Unsigned 32-bit integer containing float bits.
 * @returns {number} Float value represented by the same bits.
 */
export function cjsUint32ToFloat32(value) 
{
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, value >>> 0, true);
    return view.getFloat32(0, true);
}
