// A cat's ears are never quite still: now and then one flicks back and returns,
// sometimes both, and between flicks they drift a degree or so. Without this the
// ears only moved when the emotion changed, which at rest was never.
//
// Angles are degrees, added on top of the emotion's earAngle. Positive here means
// "flicked back" (down and out), the same direction a sad ear droops.

const FLICK_SECONDS = 0.2;

function schedule(pose) {
  // Livelier moods flick sooner. earTwitch is 0 for most emotions, 5 for thinking.
  const eager = 1 + (pose.earTwitch ?? 0) * 0.2;
  return (2.5 + Math.random() * 6) / eager;
}

export function createEarFlicks() {
  const ears = [
    { phase: -1, next: 1.5, amp: 0 },
    { phase: -1, next: 4, amp: 0 },
  ];

  /** Advance by dt seconds; returns the flick angle for [left, right]. */
  function step(dt, pose, time) {
    const out = [0, 0];
    for (let i = 0; i < 2; i++) {
      const e = ears[i];
      if (e.phase >= 0) {
        e.phase += dt;
        if (e.phase >= FLICK_SECONDS) {
          e.phase = -1;
          e.next = schedule(pose);
        } else {
          // out and back: a sine half-wave, so it starts and ends at rest
          out[i] = Math.sin((e.phase / FLICK_SECONDS) * Math.PI) * e.amp;
        }
      } else {
        e.next -= dt;
        if (e.next <= 0) {
          e.phase = 0;
          e.amp = 8 + Math.random() * 7;
          // a third of the time the other ear answers a beat later
          const other = ears[1 - i];
          if (other.phase < 0 && Math.random() < 0.33) {
            other.next = Math.min(other.next, 0.08);
            other.amp = 6 + Math.random() * 6;
          }
        }
      }
      // the resting drift: slow and small, a different rhythm for each ear
      out[i] += Math.sin(time * (0.9 + i * 0.37) + i * 2.3) * 0.8;
    }
    return out;
  }

  return { step };
}
