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
import { customByKind } from '../components/hmi/custom/registry';
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
  const [connected, setConnected] = useState(false);
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
  const [widgets, setWidgets] = useState<HmiWidget[]>([]);
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
        return customByKind(kind)?.label ?? kind;
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