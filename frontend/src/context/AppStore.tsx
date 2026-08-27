import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  createContext,
  useContext } from
'react';
import {
  AppConfig,
  PlcVariable,
  UpdateRate,
  ThemeMode,
  Language,
  PlcConnection,
  PlcVendor } from
'../models/plc';
import { HmiWidget, WidgetKind, BuiltInWidgetKind } from '../models/widget';
import { RealPLCService as MockPLCService } from '../services/RealPLCService';
import { createTranslator, widgetLabel as widgetLabelFn, TFn } from '../i18n';
import { customByKind, zipByKind } from '../components/hmi/custom/registry';
import {
  me as fetchMe,
  logout as apiLogout,
  UsuarioSesion,
  Permisos } from
'../services/authApi';
import {
  cargarProyecto,
  loadDesign,
  PROYECTO_POR_DEFECTO } from
'../utils/designStorage';
interface AppStore {
  // auth / conexión al PLC
  connected: boolean;
  plcIp: string;
  /** Marca del PLC al que se conectó ('siemens' | 'rexroth'). */
  plcVendor: PlcVendor;
  /**
   * Da de alta el PLC en el backend (POST /plcs). Para Siemens basta la IP;
   * para Rexroth se envían además usuario, contraseña, app y programa.
   * Lanza si el backend responde con error, para que el Login lo muestre.
   */
  connect: (conn: PlcConnection) => Promise<void>;
  disconnect: () => void;
  // variables
  variables: PlcVariable[];
  selectedVariables: PlcVariable[];
  toggleVariable: (id: string, selected: boolean) => void;
  // config
  config: AppConfig;
  setUpdateRate: (rate: UpdateRate) => void;
  setTheme: (theme: ThemeMode) => void;
  setLanguage: (lang: Language) => void;
  saveConfig: () => void;
  // effective theme (resolves 'auto', reacts to OS changes)
  isDark: boolean;
  // i18n
  language: Language;
  t: TFn;
  widgetLabel: (kind: WidgetKind) => string;
  // ---- MULTIUSUARIO ----
  /** Sesión activa, o null si nadie ha entrado. */
  sesion: UsuarioSesion | null;
  /** Qué puede hacer esta persona. El backend lo aplica de verdad. */
  permisos: Permisos | null;
  /** Vuelve a preguntar al servidor quién soy (tras entrar o salir). */
  refrescarSesion: () => Promise<void>;
  cerrarSesion: () => Promise<void>;
  /** Quién más está mirando ahora mismo. */
  presentes: {usuario: string;categoria: string;}[];
  /** Proyecto abierto y su versión (para el control de conflictos). */
  projectId: string;
  projectVersion: number;
  setProjectVersion: (v: number) => void;

  // canvas widgets
  widgets: HmiWidget[];
  setWidgets: React.Dispatch<React.SetStateAction<HmiWidget[]>>;
}
const Ctx = createContext<AppStore | null>(null);
const systemPrefersDark = () =>
typeof window !== 'undefined' &&
typeof window.matchMedia === 'function' &&
window.matchMedia('(prefers-color-scheme: dark)').matches;
export function AppStoreProvider({ children }: {children: React.ReactNode;}) {
  // Login deshabilitado — auto-conectado con IP por defecto
  const [connected, setConnected] = useState(true);
  const [plcIp, setPlcIp] = useState('192.168.0.1');
  const [plcVendor, setPlcVendor] = useState<PlcVendor>('siemens');
  const [variables, setVariables] = useState<PlcVariable[]>(() =>
  MockPLCService.getVariables()
  );
  const [config, setConfig] = useState<AppConfig>({
    updateRate: 1000,
    theme: 'dark',
    language: 'es'
  });
  // El diseño arranca desde la CACHÉ local para pintar al instante, y se
  // reconcilia con el servidor en cuanto responde (ver el efecto de abajo).
  const [widgets, setWidgets] = useState<HmiWidget[]>(
    () => loadDesign()?.widgets ?? []
  );
  const [sesion, setSesion] = useState<UsuarioSesion | null>(null);
  const [permisos, setPermisos] = useState<Permisos | null>(null);
  const [presentes, setPresentes] = useState<{usuario: string;categoria: string;}[]>([]);
  const [projectId] = useState<string>(PROYECTO_POR_DEFECTO);
  const [projectVersion, setProjectVersion] = useState<number>(0);
  const [osDark, setOsDark] = useState<boolean>(systemPrefersDark);
  // Subscribe to the emulated PLC value stream.
  useEffect(() => {
    const unsub = MockPLCService.subscribe(setVariables);
    MockPLCService.start(config.updateRate);
    return () => {
      unsub();
      MockPLCService.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    MockPLCService.setRate(config.updateRate);
  }, [config.updateRate]);
  // Keep the OS color-scheme preference live so 'auto' reacts in real time.
  useEffect(() => {
    if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function')
    return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setOsDark(e.matches);
    setOsDark(mq.matches);
    mq.addEventListener('change', handler as EventListener);
    return () => mq.removeEventListener('change', handler as EventListener);
  }, []);
  const isDark = config.theme === 'dark' || config.theme === 'auto' && osDark;
  // Apply the resolved theme + language to the document root.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('dark', isDark);
    root.style.colorScheme = isDark ? 'dark' : 'light';
    root.setAttribute('lang', config.language);
  }, [isDark, config.language]);
  const connect = useCallback(async (conn: PlcConnection) => {
    const vendor: PlcVendor = conn.vendor ?? 'siemens';

    // El backend ignora los campos de Rexroth cuando vendor='siemens', así que
    // se puede mandar siempre el mismo cuerpo.
    const body = {
      host: conn.ip,
      puerto: conn.puerto ?? 4840,
      vendor,
      usuario: conn.usuario ?? '',
      password: conn.password ?? '',
      app: conn.app ?? 'Application',
      programa: conn.programa ?? '',
    };

    const r = await fetch('/plcs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(data?.detail ?? `HTTP ${r.status}`);
    }
    // El backend responde ok:false cuando el PLC ya existía o faltan datos.
    if (data && data.ok === false) {
      throw new Error(data.mensaje ?? 'No se pudo agregar el PLC.');
    }

    setPlcIp(conn.ip);
    setPlcVendor(vendor);
    setConnected(true);
  }, []);
  // ================================================================ //
  // MULTIUSUARIO: sesión
  // ================================================================ //
  const refrescarSesion = useCallback(async () => {
    try {
      const d = await fetchMe();
      setSesion(d.autenticado ? d.sesion ?? null : null);
      setPermisos(d.permisos ?? null);
    } catch {
      setSesion(null);
      setPermisos(null);
    }
  }, []);

  const cerrarSesion = useCallback(async () => {
    await apiLogout();
    setSesion(null);
    setPermisos(null);
  }, []);

  // Al arrancar: ¿hay una sesión guardada de antes que siga siendo válida?
  useEffect(() => {
    void refrescarSesion();
  }, [refrescarSesion]);

  // El token puede caducar o ser revocado (un supervisor desactiva la cuenta).
  // `authApi` avisa con este evento y aquí se limpia la sesión sin recargar.
  useEffect(() => {
    const alCaducar = () => {
      setSesion(null);
      setPermisos(null);
    };
    window.addEventListener('hmi:sesion-caducada', alCaducar);
    return () => window.removeEventListener('hmi:sesion-caducada', alCaducar);
  }, []);

  // ================================================================ //
  // MULTIUSUARIO: proyecto compartido
  // ================================================================ //
  // Hidratación inicial desde el servidor. Los widgets ya se pintaron desde
  // la caché local, así que esto solo reconcilia.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const p = await cargarProyecto(projectId);
      if (!vivo || !p) return;
      setWidgets(p.widgets);
      setProjectVersion(p.version);
    })();
    return () => {
      vivo = false;
    };
  }, [projectId]);

  // Cambios hechos por OTRA persona. Llegan por el WebSocket, reenviados por
  // RealPLCService como evento del navegador.
  useEffect(() => {
    const alEvento = async (ev: Event) => {
      const msg = (ev as CustomEvent).detail;
      if (!msg) return;

      if (msg.type === 'presence') {
        setPresentes(msg.usuarios ?? []);
        return;
      }

      if (msg.type === 'project.updated' && msg.project_id === projectId) {
        // El eco de mi propio cambio se ignora: ya lo tengo pintado, y
        // reaplicarlo provocaría un parpadeo mientras arrastro.
        const miNombre = sesion?.usuario ?? '';
        if (miNombre && msg.por === miNombre) {
          setProjectVersion(msg.version);
          return;
        }

        const cambio = msg.cambio ?? {};
        if (cambio.accion === 'widget_guardado' && cambio.datos) {
          // Aplicación quirúrgica: solo el widget que cambió.
          setWidgets((prev) => {
            const i = prev.findIndex((w) => w.id === cambio.datos.id);
            if (i < 0) return [...prev, cambio.datos];
            const copia = [...prev];
            copia[i] = cambio.datos;
            return copia;
          });
        } else if (cambio.accion === 'widget_borrado') {
          setWidgets((prev) => prev.filter((w) => w.id !== cambio.widget));
        } else {
          // Cambio grande (PUT, proyecto nuevo): se recarga entero.
          const p = await cargarProyecto(projectId);
          if (p) setWidgets(p.widgets);
        }
        setProjectVersion(msg.version);
      }
    };
    window.addEventListener('hmi:ws', alEvento as EventListener);
    return () => window.removeEventListener('hmi:ws', alEvento as EventListener);
  }, [projectId, sesion]);

  const disconnect = useCallback(() => setConnected(false), []);
  const toggleVariable = useCallback((id: string, selected: boolean) => {
    MockPLCService.toggleSelected(id, selected);
  }, []);
  const setUpdateRate = useCallback(
    (updateRate: UpdateRate) =>
    setConfig((c) => ({
      ...c,
      updateRate
    })),
    []
  );
  const setTheme = useCallback(
    (theme: ThemeMode) =>
    setConfig((c) => ({
      ...c,
      theme
    })),
    []
  );
  const setLanguage = useCallback(
    (language: Language) =>
    setConfig((c) => ({
      ...c,
      language
    })),
    []
  );
  const saveConfig = useCallback(() => {
    // emulated persistence
  }, []);
  const t = useMemo(() => createTranslator(config.language), [config.language]);
  const widgetLabel = useCallback(
    (kind: WidgetKind) => {
      if (kind.startsWith('custom:')) {
        return customByKind(kind)?.label ?? zipByKind(kind)?.meta.label ?? kind.replace('custom:', '');
      }
      return widgetLabelFn(config.language, kind as BuiltInWidgetKind);
    },
    [config.language]
  );
  const selectedVariables = useMemo(
    () => variables.filter((v) => v.selected),
    [variables]
  );
  const value: AppStore = {
    connected,
    plcIp,
    plcVendor,
    connect,
    disconnect,
    variables,
    selectedVariables,
    toggleVariable,
    config,
    setUpdateRate,
    setTheme,
    setLanguage,
    saveConfig,
    isDark,
    language: config.language,
    t,
    widgetLabel,
    sesion,
    permisos,
    refrescarSesion,
    cerrarSesion,
    presentes,
    projectId,
    projectVersion,
    setProjectVersion,
    widgets,
    setWidgets
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useAppStore(): AppStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAppStore must be used within AppStoreProvider');
  return ctx;
}