// Minimal WHEP (WebRTC-HTTP Egress Protocol) playback for MediaMTX.
// One POST carries our SDP offer; the answer SDP comes back in the response body.
export async function playWhep(videoEl, whepUrl) {
  const pc = new RTCPeerConnection(); // self-hosted on the same network: no STUN/TURN needed
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  const stream = new MediaStream();
  videoEl.srcObject = stream;
  pc.ontrack = (e) => stream.addTrack(e.track);

  await pc.setLocalDescription(await pc.createOffer());
  // Wait for ICE gathering so we send one complete offer (no trickle — simpler).
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange',
      () => pc.iceGatheringState === 'complete' && resolve());
  });

  const res = await fetch(whepUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp,
  });
  if (!res.ok) { pc.close(); throw new Error(`WHEP request failed: HTTP ${res.status}`); }
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  return pc; // caller closes it when the stream ends
}
