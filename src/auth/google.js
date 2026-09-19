import db from '../db/db.js';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { initializeUserDefaults } from '../user/initializeUserDefaults.js';

function findAvailableDisplayName(baseName) {
	const base = (
		typeof baseName === 'string' && baseName.trim() ? baseName : 'Player'
	)
		.trim()
		.slice(0, 50);

	return new Promise((resolve, reject) => {
		let suffix = 0;
		const check = () => {
			const suffixText = suffix === 0 ? '' : `-${suffix + 1}`;
			const candidate = `${base.slice(0, 50 - suffixText.length)}${suffixText}`;
			db.get(
				'SELECT 1 FROM users WHERE display_name = ? LIMIT 1',
				[candidate],
				(err, row) => {
					if (err) return reject(err);
					if (!row) return resolve(candidate);
					suffix++;
					check();
				}
			);
		};
		check();
	});
}

export default function setupGoogleStrategy() {
	if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
		throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
	}
	if (!process.env.CALLBACK_URL) {
		throw new Error('Missing CALLBACK_URL');
	}

	const callbackURL = `${process.env.CALLBACK_URL}/auth/google/callback`;

	passport.use(
		new GoogleStrategy(
			{
				clientID: process.env.GOOGLE_CLIENT_ID,
				clientSecret: process.env.GOOGLE_CLIENT_SECRET,
				callbackURL,
				passReqToCallback: true
			},
			async (req, accessToken, refreshToken, profile, done) => {
				try {
					const googleSub = profile.id;
					const email = profile.emails?.[0]?.value;
					const displayName = profile.displayName;
					const avatarUrl = profile.photos?.[0]?.value;

					db.get(
						'SELECT * FROM users WHERE google_sub = ?',
						[googleSub],
						(err, existingUser) => {
							if (err) {
								return done(err);
							}

							if (existingUser) {
								db.run(
									`UPDATE users SET email = ?, avatar_url = ? WHERE google_sub = ?`,
									[email, avatarUrl, googleSub],
									(updateErr) => {
										if (updateErr) return done(updateErr);
										return done(null, existingUser);
									}
								);
							} else {
								findAvailableDisplayName(displayName)
									.then((uniqueDisplayName) => {
										db.run(
											`INSERT INTO users (google_sub, email, display_name, avatar_url)
											VALUES(?, ?, ?, ?)`,
											[googleSub, email, uniqueDisplayName, avatarUrl],
											function (insertErr) {
												if (insertErr) return done(insertErr);

												const userId = this.lastID;

												initializeUserDefaults(userId)
													.then(() => {
														db.get(
															'SELECT * FROM users WHERE id = ?',
															[userId],
															(fetchErr, newUser) => {
																if (fetchErr) return done(fetchErr);
																return done(null, newUser);
															}
														);
													})
													.catch(done);
											}
										);
									})
									.catch(done);
							}
						}
					);
				} catch (error) {
					return done(error);
				}
			}
		)
	);
}
