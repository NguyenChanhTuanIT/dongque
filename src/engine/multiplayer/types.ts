// Shared contract between the character engine and the multiplayer
// transport (WebSocket relay client in socket.ts).

export type P2PData = Record<string, number[] | number | string | boolean | null>;

export interface P2PClientData {
  p: number[];
  r: number[];
  a: number;
  seed?: number;
  /** Remote is sprinting (run cycle plays faster). */
  sprint?: boolean;
  /** Outfit: item index per equipment slot (scene/appearance.ts SLOTS). */
  outfit?: number[];
  [key: string]: any;
}

export interface ConnectionOptions {
  /** Local state object; the engine mutates it every frame. */
  data: P2PData;
  /** Minimum milliseconds between state sends while moving. */
  updateRate?: number;
  addClient?: (id: string, data: P2PClientData) => void;
  removeClient?: (id: string) => void;
  removeAllClients?: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

/** What the character engine reads from a transport. */
export interface MultiplayerConnection {
  /** Remote players by id; entries are mutated in place as updates arrive. */
  _clients: Map<string, P2PClientData>;
  _data: P2PData;
  /** Publish the local outfit (sent on join and whenever it changes). */
  _sendOutfit?(outfit: Uint8Array): void;
  /** Our id in the room ('' while disconnected). */
  readonly selfId?: string;
  sendChat?(text: string): boolean;
  sendReward?(action: number): boolean;
  sendShop?(item: string, price: number): boolean;
  /** An owned item broke (the fishing rod): the relay removes it from the wallet. */
  sendBreak?(item: string): boolean;
  /** Play-together message (see server/realm.mjs SOCIAL). */
  sendSocial?(kind: number, id: string, activity: number): boolean;
  /** Server clock in ms, shared by the room (null until known). */
  sharedNowMs?(): number | null;
  _sendProfile?(profile: import('./socket').Profile | null): Promise<void>;
  _dispose(): void;
}
