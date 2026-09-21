// The device lists ffmpeg prints on Windows, old format and new.
// Run with: npx tsx scripts/devices.test.mjs
//
// Real shapes of `ffmpeg -f dshow -list_devices true -i dummy` output.
import { windowsInputs } from '../server/audio.ts'

const cases = [
  ['a laptop with nothing installed', `[dshow @ 000] DirectShow video devices
[dshow @ 000]  "Integrated Camera"
[dshow @ 000] DirectShow audio devices
[dshow @ 000]  "Microphone Array (Realtek(R) Audio)"`,
    { mic: 'Microphone Array (Realtek(R) Audio)', loopback: null }],

  ['with VB-Cable installed', `[dshow @ 000] DirectShow audio devices
[dshow @ 000]  "Microphone (USB Audio Device)"
[dshow @ 000]  "CABLE Output (VB-Audio Virtual Cable)"`,
    { mic: 'Microphone (USB Audio Device)', loopback: 'CABLE Output (VB-Audio Virtual Cable)' }],

  ['with virtual-audio-capturer', `[dshow @ 000] DirectShow audio devices
[dshow @ 000]  "virtual-audio-capturer"
[dshow @ 000]  "Headset Microphone (Jabra)"`,
    { mic: 'Headset Microphone (Jabra)', loopback: 'virtual-audio-capturer' }],

  ['an older card with Stereo Mix', `[dshow @ 000] DirectShow audio devices
[dshow @ 000]  "Stereo Mix (Realtek High Definition Audio)"
[dshow @ 000]  "Line In (Realtek High Definition Audio)"`,
    { mic: 'Line In (Realtek High Definition Audio)', loopback: 'Stereo Mix (Realtek High Definition Audio)' }],

  ['nothing at all', `[dshow @ 000] DirectShow video devices
[dshow @ 000]  "Integrated Camera"
[dshow @ 000] DirectShow audio devices`,
    { mic: null, loopback: null }],

  ['an oddly named input, no loopback', `[dshow @ 000] DirectShow audio devices
[dshow @ 000]  "Shure MV7"`,
    { mic: 'Shure MV7', loopback: null }],
]

let bad = 0
for (const [name, dump, want] of cases) {
  const got = windowsInputs(dump)
  const ok = got.mic === want.mic && got.loopback === want.loopback
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        wanted ${JSON.stringify(want)}\n        got    ${JSON.stringify(got)}`)
}
console.log(bad ? `\n${bad} failed` : '\nall device cases pass')
process.exit(bad ? 1 : 0)
