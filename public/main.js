import * as THREE from 'three';
import { AnimatedScene } from './game/client/AnimatedScene.js';
import { GameObjectCustom } from './game/common/GameObject.js';

import PongSocketClient from './socket.js';
import { initChat } from './chat.js';
import { startGoalExplosionDemo } from './game/goalExplosionDemo.js';
import { GameAudio } from './game/audio.js';

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

function getStoredBoolean(key, fallback = false) {
	try {
		const value = localStorage.getItem(key);
		return value === null ? fallback : value === 'true';
	} catch {
		return fallback;
	}
}

function setStoredBoolean(key, value) {
	try {
		localStorage.setItem(key, String(Boolean(value)));
	} catch {
		// Preferences are best-effort when storage is unavailable.
	}
}

const prefersReducedMotion = window.matchMedia?.(
	'(prefers-reduced-motion: reduce)'
)?.matches;
const gameAudio = new GameAudio({
	muted: getStoredBoolean('pongMuted', false)
});
animatedScene.audio = gameAudio;
animatedScene.reducedEffects = getStoredBoolean(
	'pongReducedEffects',
	prefersReducedMotion
);

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

animatedScene.registerGameObject(new GameObjectCustom('socket', { socket }));

animatedScene.registerGameObject(
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
			const players = [...animatedScene.state.players.values()];
			if (players.length >= 2) {
				const localIndex = players.findIndex(
					(player) => player.username === animatedScene.username
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
	new GameObjectCustom('escapeMenu', {
		component: document.getElementById('escape-menu'),
		resumeButton: document.getElementById('escape-menu__resume'),
		exitButton: document.getElementById('escape-menu__exit'),
		helpButton: document.getElementById('escape-menu__help'),
		note: document.getElementById('escape-menu__note'),
		muteSetting: document.getElementById('setting-mute'),
		reduceMotionSetting: document.getElementById('setting-reduce-motion'),
		setOpen(isOpen) {
			this.note.textContent = animatedScene.gameOver
				? 'The match has ended. You can review the result or leave the lobby.'
				: 'The match continues while this menu is open.';
			this.component.classList.toggle('is-open', isOpen);
		},
		init() {
			this.muteSetting.checked = gameAudio.muted;
			this.reduceMotionSetting.checked = animatedScene.reducedEffects;
			window.addEventListener('keydown', (event) => {
				if (event.key !== 'Escape') return;
				if (event.target?.tagName === 'INPUT') return;
				if (
					document
						.getElementById('controls-help')
						?.classList.contains('is-open')
				)
					return;
				this.setOpen(!this.component.classList.contains('is-open'));
			});

			this.resumeButton.addEventListener('click', () => {
				this.setOpen(false);
			});

			this.helpButton.addEventListener('click', () => {
				this.setOpen(false);
				document.getElementById('controls-help')?.classList.add('is-open');
			});

			this.muteSetting.addEventListener('change', () => {
				gameAudio.setMuted(this.muteSetting.checked);
				setStoredBoolean('pongMuted', this.muteSetting.checked);
			});

			this.reduceMotionSetting.addEventListener('change', () => {
				animatedScene.reducedEffects = this.reduceMotionSetting.checked;
				setStoredBoolean(
					'pongReducedEffects',
					this.reduceMotionSetting.checked
				);
			});

			this.exitButton.addEventListener('click', () => {
				window.location.href = '/';
			});
		}
	}),
	new GameObjectCustom('controlsHelp', {
		component: document.getElementById('controls-help'),
		closeButton: document.getElementById('controls-help__close'),
		hudButton: document.createElement('button'),
		autoOpened: false,
		open() {
			this.component.classList.add('is-open');
		},
		close() {
			this.component.classList.remove('is-open');
			setStoredBoolean('pongControlsSeen', true);
		},
		init() {
			this.hudButton.id = 'hud-help-button';
			this.hudButton.type = 'button';
			this.hudButton.textContent = 'Controls';
			document.body.appendChild(this.hudButton);
			this.hudButton.addEventListener('click', () => this.open());
			this.closeButton.addEventListener('click', () => this.close());
			window.addEventListener('keydown', (event) => {
				if (event.target?.tagName === 'INPUT') return;
				if (event.key === '?' || event.code === 'KeyH') this.open();
				if (
					event.key === 'Escape' &&
					this.component.classList.contains('is-open')
				) {
					event.stopImmediatePropagation();
					this.close();
				}
			});
		},
		update() {
			const hasJoined = animatedScene.state.players.size > 0;
			this.hudButton.style.display = hasJoined ? '' : 'none';
			if (
				hasJoined &&
				!animatedScene.matchStarted &&
				!this.autoOpened &&
				!getStoredBoolean('pongControlsSeen', false)
			) {
				this.autoOpened = true;
				this.open();
			}
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
				!animatedScene.state.players.has(animatedScene.username);
			this.self.style.display = isSpectator ? '' : 'none';
		}
	}),
	new GameObjectCustom('waitingScreen', {
		component: document.getElementById('waiting'),
		playerListDisplay: document.getElementById('waiting__players'),
		scoreboardDisplay: document.getElementById('waiting__scoreboard'),
		joinCodeDisplay: document.getElementById('waiting__code'),
		startButton: document.getElementById('startButton'),
		leaveLobbyButton: document.getElementById('waiting__leaveButton'),
		players: animatedScene.state.players,
		socket,
		init() {
			this.startButton.addEventListener('click', () => {
				socket.send({ type: 'start' });
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

			this.component.style.display = 'flex';
			if (isGameOver) {
				const { winner, ratings } = animatedScene.gameOver;

				document.getElementById('waiting__title').innerText = `${
					winner ?? 'A player'
				} won`;

				this.joinCodeDisplay.style.display = 'none';
				this.playerListDisplay.style.display = 'none';
				this.startButton.style.display = 'none';
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
							${Array.from(this.players.keys())
								.map((name) => {
									const rating = ratings?.[name];
									const finalLives = animatedScene.gameOver.finalLives?.[name];
									const ratingCells = rating
										? `<td>${rating.before}</td>
	<td style="color: ${rating.change >= 0 ? 'lightgreen' : 'red'}">${rating.after} (${rating.change >= 0 ? '+' : ''}${rating.change})</td>`
										: '<td>—</td><td>—</td>';
									return `<tr>
	<td>${escapeHtml(name)}</td>
	<td>${finalLives ?? this.players.get(name).lives}${name === winner ? ' (Winner)' : ''}</td>
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
				this.leaveLobbyButton.style.display = 'block';
				this.scoreboardDisplay.style.display = 'none';

				document.getElementById('waiting__title').innerText =
					'Host left the game';

				return;
			}

			document.getElementById('waiting__title').innerText =
				'Waiting for players...';
			this.joinCodeDisplay.style.display = 'block';
			this.playerListDisplay.style.display = 'block';
			this.startButton.style.display = 'block';
			this.leaveLobbyButton.style.display = 'none';
			this.scoreboardDisplay.style.display = 'none';
			this.playerListDisplay.innerHTML = Array.from(this.players.entries())
				.map(([name, player]) => {
					const isHost = name === animatedScene.host;
					const elo = player.elo;
					return `<span style="color: ${isHost ? 'yellow' : 'white'}">
						${escapeHtml(name)} (${escapeHtml(elo)})
					</span>`;
				})
				.join('');

			if (animatedScene.isHost) {
				this.startButton.textContent = 'Start Game';
				this.startButton.disabled = this.players.size < 2;
			} else {
				this.startButton.textContent = 'Waiting for host to start the game';
				this.startButton.disabled = true;
			}
		}
	})
);

animatedScene.start();
