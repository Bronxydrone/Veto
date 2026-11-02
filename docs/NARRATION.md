# Narration script for `docs/shots/veto-demo.mp4`

The video is nine cards. **Recorded on 2026-11-02**: the mp4 now carries the narration below,
with each card stretched to its own line and the audio normalised to -16 LUFS.

The method, in case a line ever needs re-recording: one continuous take, then re-time the
cards to the recording so nothing is cut off.

**Pace:** slightly slower than conversational. About 120 words in total, which is roughly 45
seconds of speech. If it runs longer, that is fine - the cards stretch, the audio does not.

## Lines, card by card

| # | Card | Approx. time | Line |
|---|---|---|---|
| 1 | Title | 0:00 | Agents can spend. They just can't spend everything. |
| 2 | Five decisions (`npm run mvp`) | 0:03 | Five decisions: one payment allowed, three refused, one escalated to a human. |
| 3 | The policy decides (`npm run demo`) | 0:08 | Every payment is judged before the money moves, and every refusal carries a reason code. |
| 4 | 29 ways to escape (`npm run attack`) | 0:14 | We tested twenty-nine ways out. Twenty-six were refused. |
| 5 | The walls are on-chain | 0:20 | The walls are not in the agent. A contract holds the funds, and the agent's key can only ask it to spend. |
| 6 | Every refusal says why, on-chain | 0:26 | A refusal is on-chain too: the transaction reverts, and still emits the reason. |
| 7 | The bug the network found | 0:31 | The network found a bug our tests missed. Budget was written, the transfer failed. Now it refuses before it writes. |
| 8 | The agent half (`npm run agent`) | 0:36 | And the agent adapts: refused once, it reads the reason and picks a legal move. |
| 9 | Outro | 0:41 | Veto. Policy firewall for AI agents, on NEAR. The repository is open. |

Total: about 120 words.

## How to record

- Phone voice recorder is fine, any format (m4a, wav, mp3).
- Quiet room, phone 10-15 cm from the mouth, one continuous take is ideal.
- Start with two seconds of silence, then read line by line with a short pause between
  cards. If a line goes wrong, just repeat it - I will cut the bad takes.
- Do not worry about the accent. Half the demos at these events are read by people speaking
  their second language, and nobody cares as long as it is clear.

Send the file, and I will:

1. measure each line's real duration;
2. rebuild the card list with those durations (no line is ever cut off);
3. mux the audio into the mp4 with ffmpeg, keeping the video quality;
4. update the README and the video references, then push.

## If you would rather not record

Windows has speech synthesis built in, so I can generate a narration track with an English
system voice in a couple of minutes. It sounds synthetic, and a synthetic voice on an
AI-agent project is a fair thing for a judge to notice - but it is better than silence if
recording is not going to happen.
