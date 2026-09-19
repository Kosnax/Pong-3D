export default function chatHandler(socket, userId, ws, msg) {
	const displayName = socket.getUser(userId)?.displayName ?? 'Player';
	socket.broadcast({
		type: 'chat',
		content: `[${displayName}] ${msg.content}`
	});
}
