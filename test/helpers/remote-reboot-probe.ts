import { RTCPeerConnection, type RTCDataChannel } from "werift";

async function gatherIce(pc: RTCPeerConnection): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (pc.iceGatheringState !== "complete" && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  if (pc.iceGatheringState !== "complete") {
    throw new Error("ICE gathering timed out");
  }
}

async function connectPeers(): Promise<{
  client: RTCPeerConnection;
  server: RTCPeerConnection;
  channel: RTCDataChannel;
}> {
  const client = new RTCPeerConnection({ iceServers: [] });
  const server = new RTCPeerConnection({ iceServers: [] });
  const channel = client.createDataChannel("rpc");
  const opened = new Promise<void>((resolve) => {
    channel.onopen = resolve;
  });

  server.onDataChannel.subscribe((serverChannel) => {
    serverChannel.onMessage.subscribe(() => {});
  });

  const offer = await client.createOffer();
  await client.setLocalDescription(offer);
  await gatherIce(client);
  await server.setRemoteDescription(client.localDescription!);

  const answer = await server.createAnswer();
  await server.setLocalDescription(answer);
  await gatherIce(server);
  await client.setRemoteDescription(server.localDescription!);
  await opened;

  return { client, server, channel };
}

const { client, server, channel } = await connectPeers();
server.close();

// A JetKVM reboot closes its ICE UDP port while the client is still sending
// SCTP traffic. Linux returns ICMP port-unreachable through dgram's recv path.
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    channel.send(`ping-${attempt}`);
  } catch {
    // The datachannel may notice the dead peer before the loop completes.
  }
  await Bun.sleep(100);
}
await Bun.sleep(500);
client.close();
console.log("survived remote reboot");
