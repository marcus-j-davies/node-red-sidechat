const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MESSAGES_HISTORY = 100;
const MAX_TEXT = 4000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
};

module.exports = function (RED) {
	const init = () => {
		const userDir = (RED.settings && RED.settings.userDir) || process.cwd();
		const historyFile = path.join(userDir, 'sidechat-history.json');
		const imageDir = path.join(userDir, 'sidechat-images');
		let messages = [];
		let saveTimer = null;
		const read = RED.auth.needsPermission('sidechat.read');
		const write = RED.auth.needsPermission('sidechat.write');

		try {
			if (fs.existsSync(historyFile)) {
				const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
				if (Array.isArray(data)) {
					messages = data;
				}
			}
		} catch (err) {
			RED.log.warn(`[sidechat] could not read ${historyFile}: ${err.message}`);
		}

		const save = () => {
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				fs.writeFile(historyFile, JSON.stringify(messages, null, 1), (err) => {
					if (err) {
						RED.log.warn(`[sidechat] could not save: ${err.message}`);
					}
				});
			}, 250);
		};

		const publish = (event, payload) => {
			RED.comms.publish(`sidechat/${event}`, payload, false);
		};

		const whoIs = (req) => {
			if (req.user && req.user.username) {
				return {
					name: req.user.username,
					verified: true,
					permissions: req.user.permissions
				};
			}
			return { name: 'anonymous', verified: false, permissions: '*' };
		};

		const hasPermission = (perms, wanted) => {
			if (!perms) {
				return false;
			}
			const list = Array.isArray(perms) ? perms : [perms];
			return list.includes('*') || list.includes(wanted);
		};

		const imagePath = (image) => path.join(imageDir, `${image.id}.${IMAGE_TYPES[image.type]}`);

		const removeImages = (list) => {
			list
				.filter((m) => m.image)
				.forEach((m) => {
					fs.unlink(imagePath(m.image), () => {});
				});
		};

		const saveImage = (dataUrl) => {
			const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
			if (!match) {
				throw new Error('unsupported image type (use PNG, JPEG, GIF or WebP)');
			}
			const buffer = Buffer.from(match[2], 'base64');
			if (buffer.length > MAX_IMAGE_BYTES) {
				throw new Error('image too large (max 2 MB)');
			}
			const image = { id: crypto.randomBytes(8).toString('hex'), type: match[1] };
			fs.mkdirSync(imageDir, { recursive: true });
			fs.writeFileSync(imagePath(image), buffer);
			return image;
		};

		RED.httpAdmin.get('/sidechat/messages', read, (req, res) => {
			const me = whoIs(req);
			res.json({ me: me.name, verified: me.verified, messages: messages });
		});

		RED.httpAdmin.get('/sidechat/images/:id', read, (req, res) => {
			const msg = messages.find((m) => m.image && m.image.id === req.params.id);
			if (!msg) {
				return res.status(404).json({ error: 'image not found' });
			}
			fs.readFile(imagePath(msg.image), (err, buffer) => {
				if (err) {
					return res.status(404).json({ error: 'image not found' });
				}
				res.json({ data: `data:${msg.image.type};base64,${buffer.toString('base64')}` });
			});
		});

		RED.httpAdmin.post('/sidechat/messages', write, (req, res) => {
			const body = req.body || {};
			const text = typeof body.text === 'string' ? body.text.trim() : '';
			const hasImage = typeof body.image === 'string';
			if (!text && !hasImage) {
				return res.status(400).json({ error: 'empty message' });
			}
			if (text.length > MAX_TEXT) {
				return res.status(400).json({ error: 'message too long' });
			}

			let image;
			if (hasImage) {
				try {
					image = saveImage(body.image);
				} catch (err) {
					return res.status(400).json({ error: err.message });
				}
			}

			const me = whoIs(req);
			const msg = {
				id: crypto.randomBytes(8).toString('hex'),
				ts: Date.now(),
				user: me.name,
				verified: me.verified,
				text: text
			};
			if (image) {
				msg.image = image;
			}
			messages.push(msg);
			if (messages.length > MAX_MESSAGES_HISTORY) {
				removeImages(messages.slice(0, messages.length - MAX_MESSAGES_HISTORY));
				messages = messages.slice(-MAX_MESSAGES_HISTORY);
			}
			save();
			publish('message', msg);
			res.json(msg);
		});

		RED.httpAdmin.delete('/sidechat/messages/:id', write, (req, res) => {
			const me = whoIs(req);
			const idx = messages.findIndex((m) => m.id === req.params.id);
			if (idx === -1) {
				return res.status(404).json({ error: 'not found' });
			}
			const m = messages[idx];
			const isAuthor = m.user === me.name;
			if (!isAuthor && !hasPermission(me.permissions, 'sidechat.admin')) {
				return res.status(403).json({ error: 'you can only delete your own messages' });
			}
			messages.splice(idx, 1);
			removeImages([m]);
			save();
			publish('delete', { id: m.id });
			res.json({ ok: true });
		});

		RED.httpAdmin.delete('/sidechat/messages', write, (req, res) => {
			const me = whoIs(req);
			if (!hasPermission(me.permissions, 'sidechat.admin')) {
				return res.status(403).json({ error: 'clearing chat needs full admin permission' });
			}
			removeImages(messages);
			messages = [];
			save();
			publish('clear', {});
			res.json({ ok: true });
		});
	};

	RED.plugins.registerPlugin('sidechat-plugin', {
		onadd: init
	});
};
