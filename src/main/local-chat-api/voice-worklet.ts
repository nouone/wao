// The voice capture AudioWorklet source, served same-origin at
// /api/voice/worklet.js by the local API server.
//
// Why a URL and not a data: module: the page's CSP pins script-src to
// 'unsafe-inline' (no data:, no https:), and Safari enforces CSP for
// audioWorklet.addModule() too. The data: URL shipped in #19 therefore threw
// "Content Security Policy: Not allowed by CSP" - which the page's catch
// surfaced as the misleading "Microphone unavailable". A same-origin file
// satisfies both the CSP and WebKit.
export const VOICE_WORKLET_CODE = `class WaoCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (input) {
      const n = input.length | 0
      // The desktop endpointer expects 16 kHz. WebKit lets an AudioContext be
      // created at 16000 (so ratio is normally 1); if a future engine pins the
      // hardware rate instead, linear-decimate here so the stream stays honest.
      const ratio = sampleRate / 16000
      const outLen = ratio > 1 ? (n / ratio) | 0 : n
      const out = new Int16Array(outLen)
      let sum = 0
      for (let j = 0; j < outLen; j++) {
        const pos = ratio > 1 ? j * ratio : j
        const i0 = pos | 0
        const fr = pos - i0
        const v = ratio > 1 && i0 + 1 < n ? input[i0] * (1 - fr) + input[i0 + 1] * fr : input[Math.min(i0, n - 1)]
        sum += v * v
        out[j] = Math.max(-32768, Math.min(32767, (v * 32767) | 0))
      }
      this.port.postMessage({ b: out.buffer, r: Math.sqrt(sum / outLen) }, [out.buffer])
    }
    return true
  }
}
registerProcessor('wao-capture', WaoCaptureProcessor)
`
