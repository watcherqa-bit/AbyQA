// tests/agent-bus.test.js — Tests unitaires pour agent-bus.js
"use strict";

describe("agent-bus.js", () => {
  let bus;

  beforeEach(() => {
    // Purger le cache pour obtenir une instance fraîche
    delete require.cache[require.resolve("../agent-bus")];
    bus = require("../agent-bus");
    // Vider l'historique et les listeners
    bus._history = [];
    bus.removeAllListeners();
    bus.setMaxListeners(50);
  });

  test("est un singleton (même instance sur require multiples)", () => {
    const bus2 = require("../agent-bus");
    expect(bus).toBe(bus2);
  });

  test("publish() émet l'événement avec le bon nom", (done) => {
    bus.on("test:event", (evt) => {
      expect(evt._event).toBe("test:event");
      expect(evt._at).toBeTruthy();
      done();
    });
    bus.publish("test:event", { key: "SAF-123" });
  });

  test("publish() émet aussi le wildcard '*'", (done) => {
    bus.on("*", (evt) => {
      expect(evt._event).toBe("ticket:detected");
      expect(evt.key).toBe("SAF-456");
      done();
    });
    bus.publish("ticket:detected", { key: "SAF-456" });
  });

  test("publish() ajoute le payload dans l'historique", () => {
    bus.publish("test:a", { foo: 1 });
    bus.publish("test:b", { bar: 2 });
    expect(bus._history).toHaveLength(2);
    expect(bus._history[0]._event).toBe("test:a");
    expect(bus._history[0].foo).toBe(1);
    expect(bus._history[1]._event).toBe("test:b");
  });

  test("getHistory() retourne les N derniers événements", () => {
    for (var i = 0; i < 30; i++) {
      bus.publish("test:loop", { i: i });
    }
    var last5 = bus.getHistory(5);
    expect(last5).toHaveLength(5);
    expect(last5[0].i).toBe(25);
    expect(last5[4].i).toBe(29);
  });

  test("getHistory() sans argument retourne les 20 derniers", () => {
    for (var i = 0; i < 30; i++) {
      bus.publish("test:loop", { i: i });
    }
    var result = bus.getHistory();
    expect(result).toHaveLength(20);
  });

  test("l'historique est limité à _MAX_HISTORY entrées", () => {
    bus._MAX_HISTORY = 10;
    for (var i = 0; i < 20; i++) {
      bus.publish("test:overflow", { i: i });
    }
    expect(bus._history.length).toBeLessThanOrEqual(10);
    // Le premier élément doit être i=10 (les 10 premiers ont été supprimés)
    expect(bus._history[0].i).toBe(10);
  });

  test("publish() sans payload crée un event avec _event et _at", () => {
    bus.publish("empty:event");
    expect(bus._history).toHaveLength(1);
    expect(bus._history[0]._event).toBe("empty:event");
    expect(bus._history[0]._at).toBeTruthy();
  });

  test("maxListeners est configuré à 50", () => {
    expect(bus.getMaxListeners()).toBe(50);
  });
});
