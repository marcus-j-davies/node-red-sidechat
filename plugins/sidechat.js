const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MESSAGES_HISTORY = 100;
const MAX_TEXT = 4000;

module.exports = function (RED) {
	const init = () => {
		const userDir = (RED.settings && RED.settings.userDir) || process.cwd();
		const historyFile = path.join(userDir, 'sidechat-history.json');
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
			RED.log.warn('[sidechat] could not read ' + historyFile + ': ' + err.message);
		}

		const save = () => {
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				fs.writeFile(historyFile, JSON.stringify(messages, null, 1), (err) => {
					if (err) {
						RED.log.warn('[sidechat] could not save: ' + err.message);
					}
				});
			}, 250);
		};

		const publish = (event, payload) => {
			RED.comms.publish('sidechat/' + event, payload, false);
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

		RED.httpAdmin.get('/sidechat/messages', read, (req, res) => {
			const me = whoIs(req);
			res.json({ me: me.name, verified: me.verified, messages: messages });
		});

		RED.httpAdmin.post('/sidechat/messages', write, (req, res) => {
			const body = req.body || {};
			const text = typeof body.text === 'string' ? body.text.trim() : '';
			if (!text) {
				return res.status(400).json({ error: 'empty message' });
			}
			if (text.length > MAX_TEXT) {
				return res.status(400).json({ error: 'message too long' });
			}

			const me = whoIs(req);
			const msg = {
				id: crypto.randomBytes(8).toString('hex'),
				ts: Date.now(),
				user: me.name,
				verified: me.verified,
				text: text
			};
			messages.push(msg);
			if (messages.length > MAX_MESSAGES_HISTORY) {
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
			save();
			publish('delete', { id: m.id });
			res.json({ ok: true });
		});

		RED.httpAdmin.delete('/sidechat/messages', write, (req, res) => {
			const me = whoIs(req);
			if (!hasPermission(me.permissions, 'sidechat.admin')) {
				return res.status(403).json({ error: 'clearing chat needs full admin permission' });
			}
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
