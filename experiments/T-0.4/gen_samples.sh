#!/usr/bin/env bash
# experimental, not for prod — T-0.4 spike: sample audio generator
# Produces 5 × 60s WAV files (16 kHz mono PCM_S16LE) under out/samples/.
# Idempotent: skips if all 5 files exist.
set -euo pipefail

cd "$(dirname "$0")"
SAMPLES_DIR="out/samples"
mkdir -p "$SAMPLES_DIR"

# Skip if all 5 already present and non-empty.
all_present=1
for i in 1 2 3 4 5; do
  f="$SAMPLES_DIR/$(printf '%02d' "$i").wav"
  if [[ ! -s "$f" ]]; then
    all_present=0
    break
  fi
done
if [[ "$all_present" -eq 1 ]]; then
  echo "[gen_samples] all 5 sample WAVs already present — skipping."
  exit 0
fi

if ! command -v say >/dev/null 2>&1; then
  echo "[gen_samples] FATAL: macOS \`say\` not found. Cannot synthesize samples." >&2
  exit 11
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[gen_samples] FATAL: ffmpeg not found. \`brew install ffmpeg\`." >&2
  exit 12
fi

# 5 distinct ~180-word texts → ~60s each at default `say` rate.
# Topics span: declarative speech, Q-heavy speech, code-ish, formal, casual —
# representative of meeting prosody variability.
TEXT1='The architecture review meeting opened with a discussion of the new microservices migration plan. The team had been working on this proposal for six weeks. The main concerns were around data consistency, network latency, and operational complexity. Sarah presented the cost analysis showing a projected forty percent reduction in infrastructure spend over twelve months. The migration would happen in three phases. Phase one focuses on the user authentication service. Phase two handles the order processing pipeline. Phase three completes the migration of the legacy reporting service. Each phase has its own rollback plan documented in the runbook. The team agreed to start phase one next sprint. Engineering will produce a detailed design document by next Friday. Quality assurance will set up the new testing environment by the end of the week. Product management will communicate the timeline to all affected stakeholders. The meeting concluded with a brief review of action items and ownership.'

TEXT2='What is the expected latency for the new endpoint? How many concurrent users can the system handle? Why are we choosing PostgreSQL over the existing Mongo cluster? When will the load tests be ready? Where will the new service be deployed? Who is responsible for the monitoring setup? Could we get a demo of the failure recovery flow? Should we consider rate limiting at the gateway level? Would it make sense to add circuit breakers? Can the team commit to the proposed launch date? Will the new schema break any existing integrations? Have we considered the cost implications? Is there a backup plan if the migration fails? Are we sure the timeline is realistic? Did we account for the holiday freeze? Does the new design support our compliance requirements? Do we have signoff from security? Has the architecture been reviewed by the principal engineers? Was there feedback from the customer advisory board?'

TEXT3='Lets walk through the code review for pull request four eight two seven. The first change is in user controller dot ts line forty two. We replaced the synchronous database call with an async version using Promise dot all. The second change touches order service dot py at line one hundred and three. Heres the issue. We removed the redundant validation block because it duplicates the schema check in pydantic. The third change is in the React component checkout form dot tsx. We refactored the use effect hook to use the new use callback pattern. Performance improved by about thirty percent based on the React DevTools profiler. The fourth change updates the test fixtures in the jest config. The fifth change adds the new GraphQL resolver for the user preferences mutation. Tests pass on the CI pipeline. Coverage is at eighty seven percent. Lint warnings are zero. Lets merge after one more reviewer signs off.'

TEXT4='Good morning everyone and thank you for joining the quarterly business review. The third quarter results came in stronger than expected with revenue growth of eighteen percent year over year. Our enterprise segment grew by twenty three percent, driven primarily by expansion deals in the financial services vertical. The mid market segment grew by fourteen percent. Customer retention remained strong at ninety four percent gross retention and one hundred and eight percent net retention. Operating margin improved by two percentage points compared to the second quarter. Cash flow from operations was thirty two million dollars. Our balance sheet remains healthy with one hundred and ninety million dollars in cash and short term investments. Looking ahead to the fourth quarter, we expect continued momentum but at a slightly slower growth rate due to typical seasonality. Our guidance for the full year remains unchanged at twenty percent revenue growth. We will now open the floor for questions.'

TEXT5='Hey so I was thinking about the off site next month. Did you see the email from operations about the venue options? There are three places to choose from. The mountain resort looks really nice but its a bit far. The downtown hotel is super convenient but kind of generic. The third option is this cool old farmhouse outside the city. I think the farmhouse would be the most memorable. Also we should think about what activities to plan. Some folks want hiking. Others prefer cooking classes or board games. Maybe we can do a mix. By the way, are you joining the team lunch on Thursday? Sam picked the new ramen place near the office. Apparently the broth is amazing. Anyway let me know what you think about the off site venue. We need to vote by Friday. The form is in the team channel. See you at standup.'

PER_SAMPLE_WORDS=()
for t in "$TEXT1" "$TEXT2" "$TEXT3" "$TEXT4" "$TEXT5"; do
  PER_SAMPLE_WORDS+=( "$(echo "$t" | wc -w | tr -d ' ')" )
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for i in 1 2 3 4 5; do
  out="$SAMPLES_DIR/$(printf '%02d' "$i").wav"
  if [[ -s "$out" ]]; then
    echo "[gen_samples] $out already present, keeping."
    continue
  fi
  varname="TEXT$i"
  text="${!varname}"
  aiff="$WORK/$i.aiff"
  raw="$WORK/$i.wav"
  echo "[gen_samples] sample $i: ${PER_SAMPLE_WORDS[$((i-1))]} words → $aiff"
  say -o "$aiff" "$text"
  ffmpeg -y -loglevel error -i "$aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$raw"
  # Trim/pad to 60s exactly so RTF rows are commensurable.
  ffmpeg -y -loglevel error -i "$raw" -af "apad,atrim=0:60" -ar 16000 -ac 1 -c:a pcm_s16le "$out"
  dur=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$out")
  echo "[gen_samples] sample $i ready: $out (duration=$dur)"
done

echo "[gen_samples] all samples in $SAMPLES_DIR/"
ls -lh "$SAMPLES_DIR"
