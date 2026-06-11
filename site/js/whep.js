// Minimal WHEP (WebRTC-HTTP Egress Protocol) playback for MediaMTX.
// One POST carries our SDP offer; the answer SDP comes back in the response body.
export async function playWhep(videoEl, whepUrl) {
  const pc = new RTCPeerConnection(); // self-hosted on the same network: no STUN/TURN needed
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  const stream = new MediaStream();
  videoEl.srcObject = stream; // must be set before tracks arrive so the element renders them
  pc.ontrack = (e) => stream.addTrack(e.track);

  try {
    await pc.setLocalDescription(await pc.createOffer());
    // Wait for ICE gathering so we send one complete offer (no trickle — simpler).
    // Time-boxed: on restricted networks gathering can stall forever, which would
    // otherwise block the HLS fallback from ever running.
    await Promise.race([
      new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        pc.addEventListener('icegatheringstatechange',
          () => pc.iceGatheringState === 'complete' && resolve());
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ICE gathering timed out')), 10_000)),
    ]);

    const res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`WHEP request failed: HTTP ${res.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    return pc; // caller closes it when the stream ends
  } catch (err) {
    pc.close(); // never leak a half-open connection
    throw err;
  }
}
