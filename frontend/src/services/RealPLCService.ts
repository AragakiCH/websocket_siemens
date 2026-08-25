// =========================================================================
// RealPLCService.ts
// Reemplazo REAL del MockPLCService. Expone EXACTAMENTE la misma interfaz
// (getVariables / subscribe / toggleSelected / start / setRate / stop), pero
// en vez de generar datos random se conecta al WebSocket del backend FastAPI
// (/ws) y traduce los tags OPC UA a PlcVariable con plcAdapter.
//
// Gracias a que la interfaz es idéntica, en AppStore.tsx solo cambias la
// línea de import (Mock -> Real). Las vistas no se tocan.
//
// Notas:
//  * La URL es RELATIVA (window.location.host): en dev el proxy de Vite
//    (puerto 5173) reenvía /ws al backend (8000); en producción lo sirve el
//    propio FastAPI, así que también funciona sin tocar nada.
//  * `start(rate)` / `setRate(rate)` ya NO generan datos: ahora el rate es un
//    THROTTLE de re-render (cada cuánto se refresca la UI como máximo). El
//    dato real llega cuando el PLC cambia (sampling mínimo del S7 = 1000 ms).
//  * La selección de variables (checkbox de Configuración) es 100% del
//    frontend y se persiste en localStorage.
// =========================================================================
import { PlcVariable } from '../models/plc';
import { toPlcVariables } from './plcAdapter';
import { tokenParaWs } from './authApi';

const RETRY_MS = 3000;
const SELECTION_KEY = 'hmi.plc.selection'; // localStorage

type Listener = (vars: PlcVariable[]) => void;

class RealPLCServiceImpl {
  // Estado crudo recibido del backend: { "plc|tag": {plc, tag, value, type,...} }
  private tags: Record<string, any> = {};
  // Selección persistida por el usuario: id -> boolean
  private selection: Map<string, boolean> = this.loadSelection();

  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private manualClose = false;

  private rate = 1000;
  private dirty = false;
  private running = false;

  // ---- localStorage helpers ------------------------------------------- //
  private loadSelection(): Map<string, boolean> {
    try {
      const raw = localStorage.getItem(SELECTION_KEY);
      if (!raw) return new Map();
      return new Map(Object.entries(JSON.parse(raw)));
    } catch {
      return new Map();
    }
  }

  private saveSelection() {
    try {
      localStorage.setItem(
        SELECTION_KEY,
        JSON.stringify(Object.fromEntries(this.selection))
      );
    } catch {
      /* ignore */
    }
  }

  // ---- interfaz PÚBLICA (igual que MockPLCService) -------------------- //
  getVariables(): PlcVariable[] {
    return toPlcVariables(this.tags, this.selection);
  }

  /** Compat con el mock; en modo real no se usa desde fuera. */
  setVariables(_vars: PlcVariable[]) {
    /* no-op: los valores mandan desde el PLC */
  }

  toggleSelected(id: string, selected: boolean) {
    this.selection.set(id, selected);
    this.saveSelection();
    this.emitNow();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getVariables()); // snapshot inmediato
    return () => this.listeners.delete(fn);
  }

  start(rate: number) {
    this.rate = rate;
    this.running = true;
    this.openSocket();
    this.startFlush();
  }

  setRate(rate: number) {
    if (this.rate === rate) return;
    this.rate = rate;
    if (this.running) this.startFlush(); // reinicia el intervalo con el nuevo rate
  }

  stop() {
    this.running = false;
    this.manualClose = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  // ---- WebSocket ------------------------------------------------------ //
  private openSocket() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // ya abierto/abriendo
    this.manualClose = false;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // El token va en el query string porque la API de WebSocket del
    // navegador no permite cabeceras personalizadas al conectar.
    const url = tokenParaWs(`${proto}://${window.location.host}/ws`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'snapshot') {
        // Reemplaza todo el estado con lo del snapshot.
        this.tags = msg.tags ?? {};
        this.emitNow(); // refresco inmediato al conectar / al agregar PLC
      } else if (msg.type === 'plc_removed') {
        const id = msg.plc_removed;
        this.tags = Object.fromEntries(
          Object.entries(this.tags).filter(([, t]) => t.plc !== id)
        );
        this.emitNow();
      } else if (
        msg.type === 'project.updated' ||
        msg.type === 'project.removed' ||
        msg.type === 'config.updated' ||
        msg.type === 'presence'
      ) {
        // Canal de PROYECTO: baja frecuencia. Este servicio no los
        // interpreta, pero es el único que tiene el socket abierto, así
        // que los reemite como eventos del navegador y quien quiera los
        // escucha (AppStore, barra de presencia...). Evita abrir un
        // segundo WebSocket solo para esto.
        window.dispatchEvent(new CustomEvent('hmi:ws', { detail: msg }));
      } else if (msg.type === 'status') {
        // Estado de conexión de un PLC (no afecta a las variables). Se ignora.
      } else if (msg.tag) {
        // Cambio de valor de un tag en tiempo real.
        const clave = `${msg.plc}|${msg.tag}`;
        this.tags[clave] = { ...(this.tags[clave] ?? {}), ...msg };
        this.dirty = true; // se emitirá en el próximo flush (throttle)
      }
    };

    ws.onclose = () => {
      if (!this.manualClose) {
        this.retryTimer = setTimeout(() => this.openSocket(), RETRY_MS);
      }
    };

    ws.onerror = () => ws.close();
  }

  // ---- Throttle de re-render ------------------------------------------ //
  private startFlush() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      if (this.dirty) this.emitNow();
    }, this.rate);
  }

  private emitNow() {
    this.dirty = false;
    const snapshot = this.getVariables();
    this.listeners.forEach((l) => l(snapshot));
  }
}

// Se exporta con el MISMO nombre-alias que espera AppStore.
export const RealPLCService = new RealPLCServiceImpl();
