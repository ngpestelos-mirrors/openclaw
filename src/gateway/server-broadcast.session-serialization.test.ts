import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem !== "gateway/broadcast") {
        return logger;
      }
      return { ...logger, error: warnSpy };
    },
  };
});

describe("session broadcast serialization", () => {
  it("keeps recipient session permissions separate at the same sequence and profile", () => {
    const first = makeClient("first");
    const second = makeClient("second");
    const origin = { label: "Control UI", provider: "webchat", chatType: "direct" };
    const snapshotToJSON = vi.fn(() => origin);
    const session = {
      key: "agent:main:chat",
      sessionId: "session-chat",
      kind: "direct",
      label: "Release planning",
      updatedAt: 1_800_000_000_000,
      snapshotAt: 1_800_000_000_001,
      modelProvider: "openai",
      model: "gpt-5",
      totalTokens: 2048,
      totalTokensFresh: true,
      origin: { ...origin, toJSON: snapshotToJSON },
    };
    const source = { sessionKey: session.key, reason: "update", session };
    const stateVersion = { presence: 3 };
    for (const peer of [first, second]) {
      peer.client.preparedRecipientProfileId = "same-profile";
    }
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([first.client, second.client]),
      prepareSessionEventProjection: () => (client) => ({
        ...source,
        session: {
          ...session,
          sharingRole: client === first.client ? "owner" : "viewer",
        },
      }),
    });

    broadcast("sessions.changed", source, { stateVersion });

    for (const [peer, sharingRole] of [
      [first, "owner"],
      [second, "viewer"],
    ] as const) {
      expect(peer.socket.send).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: "event",
          event: "sessions.changed",
          payload: { ...source, session: { ...session, origin, sharingRole } },
          seq: 1,
          stateVersion,
          recipientProfileId: "same-profile",
        }),
        expect.any(Function),
      );
    }
    expect(snapshotToJSON).toHaveBeenCalledTimes(2);
  });

  it("does not serialize suppressed session snapshots or consume their sequences", () => {
    const peers = [makeClient("first"), makeClient("second")];
    const snapshotToJSON = vi.fn(() => ({ label: "Private session", provider: "webchat" }));
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      prepareSessionEventProjection: (event) =>
        event === "sessions.changed" ? () => undefined : undefined,
    });

    broadcast("sessions.changed", {
      sessionKey: "agent:main:hidden",
      session: {
        key: "agent:main:hidden",
        updatedAt: 1_800_000_000_000,
        origin: { toJSON: snapshotToJSON },
      },
    });

    for (const peer of peers) {
      expect(peer.socket.send).not.toHaveBeenCalled();
    }
    broadcast("skills.changed", { reason: "visible" });
    for (const peer of peers) {
      expect(peer.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
    }
    expect(snapshotToJSON).not.toHaveBeenCalled();
  });

  it("encodes publication-owned rows once while retaining recipient envelopes and message changes", () => {
    const peers = Array.from({ length: 100 }, (_, index) => makeClient(`reader-${index}`));
    const session = Object.freeze({ key: "agent:main:chat", label: "Shared session" });
    const ancestor = Object.freeze({ key: "agent:main:parent", label: "Parent session" });
    const rows = new WeakSet([session, ancestor]);
    const message = { text: '"🦞"\n\\\ud800'.repeat(256) };
    const source = { sessionKey: session.key, message };
    const projection = Object.assign(() => ({ ...source, session, ancestorSessions: [ancestor] }), {
      rows,
    });
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      prepareSessionEventProjection: (event) =>
        event === "session.message" ? projection : undefined,
    });
    peers[0]!.client.preparedRecipientProfileId = "first-profile";
    broadcastToConnIds("skills.changed", {}, new Set([peers[0]!.client.connId]));
    peers[0]!.socket.send.mockClear();
    const initial = message.text;
    peers[0]!.socket.send.mockImplementationOnce(() => {
      message.text = "Changed after the first recipient";
    });
    const stringify = vi.spyOn(JSON, "stringify");
    broadcast("session.message", source, { stateVersion: { presence: 3 } });
    const countRowEncodings = (row: object) =>
      stringify.mock.calls.filter(([value]) => {
        if (value === row) {
          return true;
        }
        if (value && typeof value === "object" && "payload" in value) {
          const payload: unknown = value.payload;
          return (
            payload !== null &&
            typeof payload === "object" &&
            (("session" in payload && payload.session === row) ||
              ("ancestorSessions" in payload &&
                Array.isArray(payload.ancestorSessions) &&
                payload.ancestorSessions.includes(row)))
          );
        }
        return false;
      }).length;
    expect(countRowEncodings(session)).toBe(1);
    expect(countRowEncodings(ancestor)).toBe(1);
    stringify.mockRestore();
    for (const [index, peer] of peers.entries()) {
      expect(peer.socket.send.mock.calls[0]?.[0]).toBe(
        JSON.stringify({
          type: "event",
          event: "session.message",
          payload: {
            ...source,
            message: { text: index === 0 ? initial : message.text },
            session,
            ancestorSessions: [ancestor],
          },
          seq: index === 0 ? 2 : 1,
          stateVersion: { presence: 3 },
          ...(index === 0 ? { recipientProfileId: "first-profile" } : {}),
        }),
      );
    }
  });

  it.each([
    [
      "first",
      {
        message: {
          text: '"🦞"\n\\\ud800'.repeat(256),
          items: [undefined, Symbol("omitted")],
        },
      },
    ],
    ["middle", { sessionKey: "agent:main:chat", message: null, omitted: undefined }],
    ["last", { sessionKey: "agent:main:chat", omitted: undefined, message: undefined }],
    ["native property key", { message: { toJSON: (key: string) => ({ key }) } }],
    ["absent", { sessionKey: "agent:main:chat", ["__proto__"]: { text: "ordinary field" } }],
  ])("preserves projected envelope bytes with the message %s", (position, source) => {
    const peers = [makeClient("owner"), makeClient("viewer")];
    const project = (client: GatewayWsClient) => {
      const session = { key: "agent:main:chat", sharingRole: client.connId };
      return position === "last" ? { session, ...source } : { ...source, session };
    };
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      prepareSessionEventProjection: () => project,
    });
    const stateVersion = { presence: 3 };
    for (const peer of peers) {
      peer.client.preparedRecipientProfileId = "same-profile";
    }

    broadcast("session.message", source, { stateVersion });

    for (const peer of peers) {
      expect(peer.socket.send.mock.calls[0]?.[0]).toBe(
        JSON.stringify({
          type: "event",
          event: "session.message",
          payload: project(peer.client),
          seq: 1,
          stateVersion,
          recipientProfileId: "same-profile",
        }),
      );
    }
  });

  it.each(["getter", "toJSON", "proxy"])(
    "observes %s message mutations between recipients when long strings repeat",
    (publisher) => {
      const peers = [makeClient("first"), makeClient("second"), makeClient("third")];
      const initial = '"🦞"\n\\\ud800'.repeat(256);
      let current = initial;
      const reads: string[] = [];
      const read = () => {
        reads.push(current);
        return current;
      };
      const message =
        publisher === "getter"
          ? {
              get text() {
                return read();
              },
            }
          : publisher === "toJSON"
            ? {
                toJSON(key: string) {
                  expect(key).toBe("message");
                  return { text: read() };
                },
              }
            : new Proxy(
                { text: initial },
                {
                  get(target, key, receiver) {
                    return key === "text" ? read() : Reflect.get(target, key, receiver);
                  },
                },
              );
      const source = { message };
      const rows = peers.map(({ client }) => Object.freeze({ sharingRole: client.connId }));
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
        prepareSessionEventProjection: () =>
          Object.assign(
            (client: GatewayWsClient) => ({
              ...source,
              session: rows.find((row) => row.sharingRole === client.connId),
            }),
            { rows: new WeakSet(rows) },
          ),
      });
      peers[0]!.socket.send.mockImplementationOnce(() => {
        current = initial + " changed";
      });
      peers[1]!.socket.send.mockImplementationOnce(() => {
        current = initial;
      });

      broadcast("session.message", source);

      expect(reads).toEqual([initial, initial + " changed", initial]);
      for (const [index, peer] of peers.entries()) {
        expect(peer.socket.send.mock.calls[0]?.[0]).toBe(
          JSON.stringify({
            type: "event",
            event: "session.message",
            payload: {
              message: { text: reads[index] },
              session: { sharingRole: peer.client.connId },
            },
            seq: 1,
          }),
        );
      }
    },
  );

  it.each(["message", "first recipient", "second recipient", "source toJSON"])(
    "consumes only delivered sequences when %s cannot serialize",
    (failure) => {
      warnSpy.mockClear();
      const first = makeClient("first");
      const second = makeClient("second");
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const source = { message: failure === "message" ? circular : { content: "visible" } };
      if (failure === "source toJSON") {
        Object.defineProperty(source, "toJSON", {
          value: () => {
            throw new Error("source toJSON failed");
          },
        });
      }
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([first.client, second.client]),
        prepareSessionEventProjection: (event) =>
          event === "session.message"
            ? (client) => ({
                ...source,
                session:
                  failure === `${client.connId} recipient`
                    ? circular
                    : { sharingRole: client.connId },
              })
            : undefined,
      });

      broadcast("session.message", source);
      expect(first.socket.send).toHaveBeenCalledTimes(failure === "second recipient" ? 1 : 0);
      expect(second.socket.send).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("broadcast serialization failed for event session.message"),
      );
      broadcast("skills.changed", { reason: "recovered" });
      expect(first.socket.frames.at(-1)).toEqual({
        event: "skills.changed",
        seq: failure === "second recipient" ? 2 : 1,
      });
      expect(second.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
    },
  );

  it("preserves projected message delivery through reentrant sends and later broadcasts", () => {
    const first = makeClient("first");
    const second = makeClient("second");
    let message = { content: "outer" };
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([first.client, second.client]),
      prepareSessionEventProjection: () => {
        const current = message;
        return (client) => ({ message: current, session: { sharingRole: client.connId } });
      },
    });
    first.socket.send.mockImplementationOnce(() => {
      message = { content: "inner" };
      broadcastToConnIds("session.message", { message }, new Set(["first"]));
    });

    broadcast("session.message", { message });
    message = { content: "later" };
    broadcast("session.message", { message });

    const delivered = (peer: ReturnType<typeof makeClient>) =>
      peer.socket.send.mock.calls.map(([frame]) => {
        const parsed = JSON.parse(frame);
        return [parsed.payload.message.content, parsed.seq, parsed.payload.session.sharingRole];
      });
    expect(delivered(first)).toEqual([
      ["outer", 1, "first"],
      ["inner", 2, "first"],
      ["later", 3, "first"],
    ]);
    expect(delivered(second)).toEqual([
      ["outer", 1, "second"],
      ["later", 2, "second"],
    ]);
  });

  it.each(
    ["session.message", "sessions.changed"].flatMap((event) =>
      ["own accessor", "inherited accessor", "proxy"].map((publisher) => ({ event, publisher })),
    ),
  )(
    "keeps native $event source serialization and stateVersion ordering for $publisher publishers",
    ({ event, publisher }) => {
      for (const throwOnRepeat of [false, true]) {
        const peer = makeClient("native-hook");
        const stateVersion = { presence: 1 };
        const projected = {
          sessionKey: "agent:main:hook",
          ...(event === "session.message"
            ? { message: { content: "projected" } }
            : { session: { key: "agent:main:hook", label: "Projected session" } }),
        };
        const source = { sessionKey: projected.sessionKey };
        let read = false;
        const readToJSON = () => {
          if (read && throwOnRepeat) {
            throw new Error("repeated source hook lookup");
          }
          read = true;
          stateVersion.presence = 9;
          return () => ({ source: "serialized" });
        };
        let payload = source;
        if (publisher === "proxy") {
          payload = new Proxy(source, {
            get(target, property, receiver) {
              return property === "toJSON" ? readToJSON() : Reflect.get(target, property, receiver);
            },
            getPrototypeOf() {
              throw new Error("unexpected source prototype lookup");
            },
            has() {
              throw new Error("unexpected source property lookup");
            },
          });
        } else {
          const owner = publisher === "own accessor" ? source : {};
          Object.defineProperty(owner, "toJSON", { get: readToJSON });
          if (publisher === "inherited accessor") {
            Object.setPrototypeOf(source, owner);
          }
        }
        const { broadcast } = createGatewayBroadcaster({
          clients: new GatewayClientRegistry([peer.client]),
          prepareSessionEventProjection: () => () => projected,
        });

        broadcast(event, payload, { stateVersion });

        expect.soft(peer.socket.send).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({
            type: "event",
            event,
            payload: projected,
            seq: 1,
            stateVersion: { presence: 1 },
          }),
          expect.any(Function),
        );
      }
    },
  );
});
