import PongSocketHub from '../socket.js';
import chatHandler from './chat.js';
import ServerScene from '../game/ServerScene.js';
import SharedGameLoop from '../game/SharedGameLoop.js';

let nextLobbyId = 1;
const EMPTY_LOBBY_DELETE_TIME = 60_000;
const PLAYER_RESERVATION_MS = 20_000;

function generateCode() {
	const length = 5;
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let out = '';
	for (let i = 0; i < length; i++) {
		out += chars[Math.floor(Math.random() * chars.length)];
	}
	return out;
}

export default class LobbyState {
	#socketHub;
	#gameLoop;

	constructor(server, parseSession, socketHub = null, gameLoop = null) {
		this.#socketHub = socketHub ?? new PongSocketHub(server, parseSession);
		this.#gameLoop = gameLoop ?? new SharedGameLoop();
		this.lobbies = new Map();
		this.scenes = new Map();
		this.codeToLobby = new Map();
		this.sockets = new Map();
	}

	createLobby(name, isPublic, lives, owner) {
		const lobbyId = String(nextLobbyId++);
		let code;
		do code = generateCode();
		while (this.codeToLobby.has(code));

		const hostUserId = String(owner.id);
		const lobby = {
			lobbyId,
			name,
			isPublic,
			lives,
			hostUserId,
			members: new Map(),
			playerReservations: new Map([
				[hostUserId, Date.now() + PLAYER_RESERVATION_MS]
			]),
			emptySince: Date.now(),
			code
		};

		this.lobbies.set(lobbyId, lobby);
		this.codeToLobby.set(code, lobby);
		const socket = this.#socketHub.createLobbyChannel(code);
		this.sockets.set(lobbyId, socket);

		let scene;
		socket.on('client:connect', (userId, profile, connectionInfo) => {
			if (!this.joinLobby(lobbyId, userId, profile)) {
				socket.disconnectUser(userId, 4004, 'Lobby is no longer available');
				return;
			}

			const player = scene?.state.players.get(userId);
			const verb =
				connectionInfo.reconnecting && player ? 'reconnected' : 'joined';
			socket.broadcast({
				type: 'chat',
				content: `[System] ${profile.displayName} ${verb}`
			});
		});

		socket.on('client:disconnect', (userId, profile) => {
			if (!this.lobbies.has(lobbyId)) return;
			this.markDisconnected(lobbyId, userId);
			if (!scene?.hasPlayer(userId)) {
				lobby.members.delete(userId);
			}
			socket.broadcast({
				type: 'chat',
				content: `[System] ${profile.displayName} lost connection`
			});
		});

		socket.addHandler('chat', chatHandler);
		scene = new ServerScene(socket, lives, () => {}, {
			hostUserId,
			onHostChanged: (nextHostUserId) => {
				lobby.hostUserId = nextHostUserId;
			},
			onPlayerRemoved: (userId) => {
				const member = lobby.members.get(userId);
				if (!member?.connected) lobby.members.delete(userId);
			},
			scheduler: this.#gameLoop
		});
		this.scenes.set(lobbyId, scene);

		return lobby;
	}

	getLobbyFromCode(code) {
		return this.codeToLobby.get(String(code).toUpperCase());
	}

	isLobbyInProgress(lobby) {
		return this.scenes.get(lobby.lobbyId)?.inProgress === true;
	}

	findJoinableLobby(userId) {
		const normalizedUserId = String(userId);
		const lobby =
			Array.from(this.lobbies.values()).find((lobby) => {
				if (!lobby.isPublic) return false;
				const scene = this.scenes.get(lobby.lobbyId);
				const availablePlayerSlots = this.#availablePlayerSlots(lobby);
				const alreadyReserved = lobby.playerReservations.has(normalizedUserId);
				return (
					scene?.canAcceptPlayer(normalizedUserId) === true &&
					(alreadyReserved || availablePlayerSlots > 0)
				);
			}) ?? null;
		if (lobby) {
			lobby.playerReservations.set(
				normalizedUserId,
				Date.now() + PLAYER_RESERVATION_MS
			);
		}
		return lobby;
	}

	listLobbies() {
		return Array.from(this.lobbies.values())
			.filter((lobby) => lobby.isPublic)
			.map((lobby) => this.serializeLobby(lobby));
	}

	serializeLobby(lobby) {
		const scene = this.scenes.get(lobby.lobbyId);
		const availablePlayerSlots = this.#availablePlayerSlots(lobby);
		const connectedMembers = Array.from(lobby.members.values()).filter(
			(member) => member.connected
		);
		return {
			lobbyId: lobby.lobbyId,
			name: lobby.name,
			code: lobby.code,
			isPublic: lobby.isPublic,
			lives: lobby.lives,
			hostUserId: lobby.hostUserId,
			memberCount: connectedMembers.length,
			playerCount: scene?.playerCount ?? 0,
			spectatorCount: connectedMembers.filter(
				(member) => !scene?.hasPlayer(member.userId)
			).length,
			status: scene?.status ?? 'waiting',
			joinableAsPlayer: scene?.status === 'waiting' && availablePlayerSlots > 0
		};
	}

	#availablePlayerSlots(lobby) {
		const now = Date.now();
		const scene = this.scenes.get(lobby.lobbyId);
		if (!scene) return 0;
		for (const [userId, expiresAt] of lobby.playerReservations) {
			if (scene?.hasPlayer(userId)) {
				lobby.playerReservations.delete(userId);
				continue;
			}
			if (expiresAt <= now) {
				lobby.playerReservations.delete(userId);
				if (userId === lobby.hostUserId) {
					const replacementHostUserId =
						[...scene.state.players.keys()].find((id) => scene.hasPlayer(id)) ??
						null;
					scene.setHostUserId(replacementHostUserId);
				}
			}
		}
		const playerCount = scene?.playerCount ?? 0;
		return Math.max(0, 2 - playerCount - lobby.playerReservations.size);
	}

	joinLobby(lobbyId, userId, profile) {
		const lobby = this.lobbies.get(lobbyId);
		if (!lobby) return false;
		lobby.members.set(String(userId), {
			userId: String(userId),
			displayName: profile.displayName,
			connected: true
		});
		lobby.playerReservations.delete(String(userId));
		lobby.emptySince = null;
		return true;
	}

	markDisconnected(lobbyId, userId) {
		const lobby = this.lobbies.get(lobbyId);
		if (!lobby) return false;
		const member = lobby.members.get(String(userId));
		if (member) member.connected = false;
		if (![...lobby.members.values()].some((entry) => entry.connected)) {
			lobby.emptySince = Date.now();
		}
		return true;
	}

	deleteLobby(lobbyId) {
		const lobby = this.lobbies.get(lobbyId);
		if (!lobby) return;

		this.scenes.get(lobbyId)?.stop();
		this.scenes.delete(lobbyId);
		this.sockets.get(lobbyId)?.stop();
		this.sockets.delete(lobbyId);
		this.codeToLobby.delete(lobby.code);
		this.lobbies.delete(lobbyId);
	}

	cleanup() {
		const now = Date.now();
		for (const [lobbyId, lobby] of this.lobbies) {
			if (
				lobby.emptySince !== null &&
				now - lobby.emptySince >= EMPTY_LOBBY_DELETE_TIME
			) {
				this.deleteLobby(lobbyId);
			}
		}
	}
}
