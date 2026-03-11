// agent-bus.js — Event Bus inter-agents (singleton)
// Permet aux agents de communiquer via des événements typés.
// Tous les require("./agent-bus") retournent la même instance.
"use strict";

const EventEmitter = require("events");

class AgentBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._history = [];
    this._MAX_HISTORY = 200;
  }

  // Émet un événement typé avec timestamp + historique
  publish(eventName, payload) {
    var event = Object.assign({}, payload || {}, {
      _event: eventName,
      _at: new Date().toISOString()
    });
    this._history.push(event);
    if (this._history.length > this._MAX_HISTORY) this._history.shift();
    this.emit(eventName, event);
    // Wildcard pour le bridge SSE (agent-server.js écoute "*")
    this.emit("*", event);
  }

  // Derniers N événements (debug)
  getHistory(n) {
    return this._history.slice(-(n || 20));
  }
}

module.exports = new AgentBus();
