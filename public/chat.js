const MAX_CHAT = 100;

export function initChat(socket) {
	const chat = document.getElementById('chat');
	const chatText = document.getElementById('chat__text');
	const chatbox = document.getElementById('chat__box');
	let recentMessageTimer = null;

	const revealRecentMessage = () => {
		chat?.classList.add('has-recent-message');
		clearTimeout(recentMessageTimer);
		recentMessageTimer = setTimeout(() => {
			if (document.activeElement !== chatbox) {
				chat?.classList.remove('has-recent-message');
			}
		}, 4500);
	};

	window.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			if (document.activeElement === chatbox) {
				const content = chatbox.value.trim();
				if (content) socket.send({ type: 'chat', content });

				chatbox.value = '';
				chatbox.blur();
				chat?.classList.remove('has-recent-message');
			} else {
				chatbox.focus();
			}
		}

		if (e.key === 'Escape' && document.activeElement === chatbox) {
			e.preventDefault();
			e.stopImmediatePropagation();
			chatbox.value = '';
			chatbox.blur();
			chat?.classList.remove('has-recent-message');
		}
	});

	let msgs = [];
	socket.addHandler('chat', (msg, respond) => {
		msgs.push(msg.content);
		msgs = msgs.slice(-MAX_CHAT);
		chatText.innerText = msgs.join('\n');

		chatText.scrollTop = chatText.scrollHeight;
		revealRecentMessage();

		return true;
	});
}
