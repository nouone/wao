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
      const out = new Int16Array(n)
      let sum = 0
      for (let i = 0; i < n; i++) {
        const v = input[i]
        sum += v * v
        out[i] = Math.max(-32768, Math.min(32767, (v * 32767) | 0))
      }
      this.port.postMessage({ b: out.buffer, r: Math.sqrt(sum / n) }, [out.buffer])
    }
    return true
  }
}
registerProcessor('wao-capture', WaoCaptureProcessor)
`
