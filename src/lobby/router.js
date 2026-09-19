import { Router } from 'express';
import LobbyState from './lobbyState.js';

export default function createLobbyRouter(server, parseSession) {
	const router = Router();
	const lobbyState = new LobbyState(server, parseSession);
	setInterval(() => {
		lobbyState.cleanup();
	}, 5000);

	router.get('/api/lobbies', (_req, res) => {
		res.json({ lobbies: lobbyState.listLobbies() });
	});

	router.post('/api/lobbies', (req, res) => {
		if (!req.user) return res.sendStatus(401);

		const suppliedName = req.body?.name;
		const name =
			typeof suppliedName === 'string' && suppliedName.trim().length > 0
				? suppliedName.trim().slice(0, 100)
				: `${req.user.display_name}’s lobby`;
		const lives = req.body?.lives ?? 7;
		if (!Number.isInteger(lives) || lives < 1 || lives > 100) {
			return res.status(400).json({
				ok: false,
				message: 'Lives must be an integer between 1 and 100'
			});
		}
		const isPublic = req.body?.isPublic === true;
		const lobby = lobbyState.createLobby(name, isPublic, lives);

		res.json({ lobby });
	});

	router.get('/api/lobbies/:lobbyId', (req, res) => {
		const lobbyId = req.params.lobbyId;
		const lobby = lobbyState.lobbies.get(lobbyId);

		if (!lobby) {
			res.status(404).json({ ok: false, message: 'Lobby not found' });
			return;
		}

		res.json({
			ok: true,
			lobby: {
				lobbyId: lobby.lobbyId,
				name: lobby.name,
				hostUser: lobby.hostUser,
				isPublic: lobby.isPublic,
				memberCount: lobby.members.size,
				members: Array.from(lobby.members.values())
			}
		});
	});

	router.get('/game', (req, res) => {
		if (!req.user) {
			return res.sendStatus(401);
		}

		const { code } = req.query;

		if (!code || !code.length) {
			return res.sendStatus(400);
		}

		const lobby = lobbyState.getLobbyFromCode(code);
		if (!lobby) {
			return res.status(404).send('Lobby not found');
		}

		const username = req.user.display_name;
		if (lobby.members.get(username)) {
			return res.status(400).send('Username is taken');
		}

		res.render('game', { code, lobbyName: lobby.name, username });
	});

	router.get('/', (req, res) => {
		res.render('lobbies', {
			user: req.user
		});
	});

	return router;
}
