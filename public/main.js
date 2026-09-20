import * as THREE from 'three';
import { AnimatedScene } from './game/client/AnimatedScene.js';
import { GameObjectCustom } from './game/common/GameObject.js';

import PongSocketClient from './socket.js';
import { initChat } from './chat.js';
import { startGoalExplosionDemo } from './game/goalExplosionDemo.js';
import { GameAudio } from './game/audio.js';
import { WaitingPractice } from './game/client/WaitingPractice.js';

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (character) => {
		const entities = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#39;'
		};
		return entities[character];
	});
}
//Temporary flag to allow viewing of goalExplosionDemo by devs
if (false) {
	startGoalExplosionDemo();
}

const socket = new PongSocketClient();
initChat(socket);
socket.connect();

const animatedScene = new AnimatedScene(socket);
window.animatedScene = animatedScene;
const gameAudio = new GameAudio();
animatedScene.audio = gameAudio;
const waitingPractice = new WaitingPractice(animatedScene);

window.addEventListener('pointerdown', () => gameAudio.unlock(), {
	once: true
});
window.addEventListener('keydown', () => gameAudio.unlock(), { once: true });

function getRespawnCountdownSeconds() {
	const respawnEndsAt = animatedScene.respawnEndsAt;
	if (typeof respawnEndsAt !== 'number') return null;

	const msRemaining = Math.max(0, respawnEndsAt - animatedScene.serverNowMs);
	if (msRemaining <= 0) return null;
	return Math.ceil(msRemaining / 1000);
}

function getReconnectCountdownSeconds() {
	const expiresAt = animatedScene.reconnectStatus?.expiresAt;
	if (!Number.isFinite(expiresAt)) return null;
	return Math.max(0, Math.ceil((expiresAt - animatedScene.serverNowMs) / 1000));
}

animatedScene.registerGameObject(new GameObjectCustom('socket', { socket }));

animatedScene.registerGameObject(
	new GameObjectCustom('waitingPractice', {
		update() {
			waitingPractice.update();
		},
		kill() {
			waitingPractice.stop();
		}
	}),
	new GameObjectCustom('ambientLight', {
		visual: new THREE.AmbientLight(0xffffff, 0.2)
	}),
	new GameObjectCustom('light1', {
		visual: new THREE.PointLight(0xffffff, 1000, 100),
		init() {
			this.visual.position.set(0, 0, 0);
			this.visual.castShadow = true;
			this.visual.shadow.mapSize.set(1024, 1024);
		}
	}),
	new GameObjectCustom('light2', {
		visual: new THREE.PointLight(0xffffff, 1000, 100),
		init() {
			this.visual.position.set(-8, 0, 0);
			this.visual.castShadow = true;
			this.visual.shadow.mapSize.set(1024, 1024);
		}
	}),
	new GameObjectCustom('light3', {
		visual: new THREE.PointLight(0xffffff, 1000, 100),
		init() {
			this.visual.position.set(8, 0, 0);
			this.visual.castShadow = true;
			this.visual.shadow.mapSize.set(1024, 1024);
		}
	}),
	new GameObjectCustom('hudScore', {
		self: document.createElement('div'),
		init() {
			this.self.id = 'hud-score';
			this.self.classList.add('hud-overlay');
			document.body.appendChild(this.self);
		},
		update() {
			this.self.classList.toggle(
				'hud-score--waiting-practice',
				waitingPractice.active
			);
			if (waitingPractice.active) {
				this.self.style.display = '';
				this.self.textContent = waitingPractice.scoreText;
				return;
			}
			const players = [...animatedScene.state.players.values()];
			if (players.length >= 2) {
				const localIndex = players.findIndex(
					(player) => player.userId === animatedScene.userId
				);
				if (localIndex > 0) {
					const [localPlayer] = players.splice(localIndex, 1);
					players.unshift(localPlayer);
				}
				const [first, second] = players;
				this.self.style.display = '';
				this.self.textContent = `${first.username} ${first.lives} — ${second.lives} ${second.username}`;
			} else {
				this.self.style.display = 'none';
			}
		}
	}),
	new GameObjectCustom('hudWaiting', {
		self: document.createElement('div'),
		init() {
			this.self.id = 'hud-waiting';
			this.self.classList.add('hud-overlay');
			this.self.textContent = 'Waiting for players...';
			this.self.setAttribute('role', 'status');
			this.self.setAttribute('aria-live', 'polite');
			document.body.appendChild(this.self);
		},
		update() {
			this.self.style.display = waitingPractice.active ? '' : 'none';
		}
	}),
	new GameObjectCustom('hudCountdown', {
		self: document.createElement('div'),
		scorerText: document.createElement('div'),
		countdownText: document.createElement('div'),
		lastCountdown: null,
		init() {
			this.self.id = 'hud-countdown';
			this.self.classList.add('hud-overlay');
			this.scorerText.className = 'hud-countdown__scorer';
			this.countdownText.className = 'hud-countdown__value';
			this.self.appendChild(this.scorerText);
			this.self.appendChild(this.countdownText);
			document.body.appendChild(this.self);
		},
		update() {
			const countdown = getRespawnCountdownSeconds();
			const scorer = animatedScene.respawnScorer;
			if (typeof countdown !== 'number' || countdown <= 0) {
				this.self.style.display = 'none';
				this.lastCountdown = null;
				return;
			}

			this.self.style.display = '';
			const scoredText =
				typeof scorer === 'string' && scorer.length > 0
					? `${scorer} scored!`
					: '';
			this.scorerText.style.display = scoredText ? '' : 'none';
			this.scorerText.textContent = scoredText;
			this.countdownText.textContent = `${countdown}`;
			if (countdown !== this.lastCountdown) {
				gameAudio.playCountdown(countdown);
				this.lastCountdown = countdown;
			}
		}
	}),
	new GameObjectCustom('hudStats', {
		self: document.createElement('div'),
		socket,
		init() {
			this.self.id = 'hud-stats';
			this.self.classList.add('hud-overlay');
			document.body.appendChild(this.self);
			window.addEventListener('keydown', (event) => {
				if (event.code !== 'F3') return;
				event.preventDefault();
				document.body.classList.toggle('show-debug');
			});
		},
		update(dt) {
			const pingText =
				this.socket?.lastLatencyMs == null
					? '-- ms'
					: `${this.socket.lastLatencyMs.toFixed(0)} ms`;
			const fpsText = dt > 0 ? `${(1 / dt).toFixed(0)}` : '--';
			this.self.textContent = `FPS: ${fpsText}   Ping: ${pingText}`;
		}
	}),
	new GameObjectCustom('reconnectBanner', {
		self: document.createElement('div'),
		init() {
			this.self.id = 'hud-reconnect';
			this.self.classList.add('hud-overlay');
			this.self.setAttribute('role', 'status');
			this.self.setAttribute('aria-live', 'polite');
			document.body.appendChild(this.self);
		},
		update() {
			const status = animatedScene.reconnectStatus;
			const seconds = getReconnectCountdownSeconds();
			if (!status || seconds === null || seconds <= 0) {
				this.self.style.display = 'none';
				return;
			}
			this.self.style.display = '';
			this.self.textContent = `${status.username} disconnected — waiting ${seconds}s to reconnect`;
		}
	}),
	new GameObjectCustom('escapeMenu', {
		component: document.getElementById('escape-menu'),
		resumeButton: document.getElementById('escape-menu__resume'),
		exitButton: document.getElementById('escape-menu__exit'),
		note: document.getElementById('escape-menu__note'),
		setOpen(isOpen) {
			this.note.textContent = animatedScene.gameOver
				? 'The match has ended. You can review the result or leave the lobby.'
				: 'The match continues while this menu is open.';
			this.component.classList.toggle('is-open', isOpen);
		},
		init() {
			window.addEventListener('keydown', (event) => {
				if (event.key !== 'Escape') return;
				if (event.target?.tagName === 'INPUT') return;
				this.setOpen(!this.component.classList.contains('is-open'));
			});

			this.resumeButton.addEventListener('click', () => {
				this.setOpen(false);
			});

			this.exitButton.addEventListener('click', () => {
				window.location.href = '/';
			});
		}
	}),
	new GameObjectCustom('spectatorHint', {
		self: document.createElement('div'),
		init() {
			this.self.id = 'hud-spectator';
			this.self.classList.add('hud-overlay');
			this.self.textContent = 'Spectating · ←/→ change camera · drag to orbit';
			document.body.appendChild(this.self);
		},
		update() {
			const isSpectator =
				animatedScene.matchStarted &&
				animatedScene.gameOver === null &&
				animatedScene.state.players.size >= 2 &&
				!animatedScene.state.players.has(animatedScene.userId);
			this.self.style.display = isSpectator ? '' : 'none';
		}
	}),
	new GameObjectCustom('waitingScreen', {
		component: document.getElementById('waiting'),
		playerListDisplay: document.getElementById('waiting__players'),
		scoreboardDisplay: document.getElementById('waiting__scoreboard'),
		joinCodeDisplay: document.getElementById('waiting__code'),
		startButton: document.getElementById('startButton'),
		readyButton: document.getElementById('readyButton'),
		leaveLobbyButton: document.getElementById('waiting__leaveButton'),
		players: animatedScene.state.players,
		socket,
		init() {
			this.startButton.addEventListener('click', () => {
				socket.send({ type: 'start' });
			});

			this.readyButton.addEventListener('click', () => {
				const player = this.players.get(animatedScene.userId);
				if (!player) return;
				if (animatedScene.gameOver) {
					socket.send({ type: 'rematch', ready: !player.rematchReady });
				} else {
					socket.send({ type: 'ready', ready: !player.ready });
				}
			});

			this.leaveLobbyButton.addEventListener('click', async () => {
				window.location.href = '/';
			});
		},
		update(dt) {
			const isGameOver = animatedScene.gameOver !== null;
			if (animatedScene.matchStarted && !isGameOver) {
				this.component.style.display = 'none';
				return;
			}
			if (animatedScene.state.players.size < 2 && !isGameOver) {
				this.component.style.display = 'none';
				return;
			}

			this.component.style.display = 'flex';
			if (isGameOver) {
				const { winner, winnerId, ratings } = animatedScene.gameOver;

				document.getElementById('waiting__title').innerText = `${
					winner ?? 'A player'
				} won`;

				this.joinCodeDisplay.style.display = 'none';
				this.playerListDisplay.style.display = 'none';
				this.startButton.style.display = 'none';
				const localPlayer = this.players.get(animatedScene.userId);
				this.readyButton.style.display = localPlayer ? 'block' : 'none';
				this.readyButton.textContent = localPlayer?.rematchReady
					? 'Rematch Requested — Waiting for Opponent'
					: 'Request Rematch';
				this.leaveLobbyButton.style.display = 'block';
				this.scoreboardDisplay.style.display = 'block';

				this.scoreboardDisplay.innerHTML = `
					<table>
						<thead>
							<tr>
								<th>Name</th>
								<th>Final Lives</th>
								<th>Old Elo</th>
								<th>New Elo</th>
							</tr>
						</thead>
						<tbody>
							${Array.from(this.players.entries())
								.map(([userId, player]) => {
									const rating = ratings?.[userId];
									const finalLives =
										animatedScene.gameOver.finalLives?.[userId];
									const ratingCells = rating
										? `<td>${rating.before}</td>
	<td style="color: ${rating.change >= 0 ? 'lightgreen' : 'red'}">${rating.after} (${rating.change >= 0 ? '+' : ''}${rating.change})</td>`
										: '<td>—</td><td>—</td>';
									return `<tr>
	<td>${escapeHtml(player.username)}</td>
	<td>${finalLives ?? player.lives}${userId === winnerId ? ' (Winner)' : ''}</td>
	${ratingCells}
</tr>`;
								})
								.join('\n')}
						</tbody>
					</table>
					${animatedScene.unlockedItem ? `<div style="margin-top: 1rem; color: gold"><strong>Item Unlocked:</strong> ${escapeHtml(animatedScene.unlockedItem.displayName)}</div>` : ''}
				`;

				return;
			} else if (animatedScene.gameCancelled) {
				this.joinCodeDisplay.style.display = 'none';
				this.playerListDisplay.style.display = 'none';
				this.startButton.style.display = 'none';
				this.readyButton.style.display = 'none';
				this.leaveLobbyButton.style.display = 'block';
				this.scoreboardDisplay.style.display = 'none';

				document.getElementById('waiting__title').innerText =
					'Host left the game';

				return;
			}

			document.getElementById('waiting__title').innerText = 'Ready up';
			this.joinCodeDisplay.style.display = 'block';
			this.playerListDisplay.style.display = 'block';
			this.startButton.style.display = 'block';
			const localPlayer = this.players.get(animatedScene.userId);
			this.readyButton.style.display = localPlayer ? 'block' : 'none';
			this.readyButton.textContent = localPlayer?.ready ? 'Ready ✓' : 'Ready';
			this.leaveLobbyButton.style.display = 'none';
			this.scoreboardDisplay.style.display = 'none';
			this.playerListDisplay.innerHTML = Array.from(this.players.entries())
				.map(([userId, player]) => {
					const isHost = userId === animatedScene.hostUserId;
					const elo = player.elo;
					const state = !player.connected
						? 'reconnecting'
						: player.ready
							? 'ready'
							: 'not ready';
					return `<span style="color: ${isHost ? 'yellow' : 'white'}">
						${escapeHtml(player.username)} (${escapeHtml(elo)}) — ${state}
					</span>`;
				})
				.join('');

			if (animatedScene.isHost) {
				this.startButton.textContent = 'Start Game';
				this.startButton.disabled =
					this.players.size < 2 ||
					[...this.players.values()].some(
						(player) => !player.connected || !player.ready
					);
			} else {
				this.startButton.textContent = 'Waiting for host to start the game';
				this.startButton.disabled = true;
			}
		}
	})
);

animatedScene.start();
