#!/usr/bin/env node
// Boot-race fix: load the bootstrap entry, which binds the daemon port
// immediately and buffers requests while the heavy core module graph loads.
import '../dist/daemon-bootstrap.js';
