// =========================================================================
// funcion/enVivo.ts
// El «modo función» CALCULANDO: lo que ve el widget cuando tiene una
// función configurada.
//
// QUÉ HACE
//
//   Para cada salida con código (varPrincipal o una variable con nombre),
//   junta los valores actuales de sus tags de entrada, se los manda al
//   servidor (`POST /funciones/evaluar`) y sustituye la variable del widget
//   por una con el valor calculado. El widget no se entera: recibe una
//   `PlcVariable` como siempre, solo que su `value` lo puso Python.
//
// CUÁNDO SE MANDA
//
//   Cuando cambia alguna entrada o el código, y como mucho cuatro veces por
//   segundo por salida (`ESPERA_MS`). Las lecturas del PLC llegan a 100 ms;
//   mandar una petición por cada una sería inundar el servidor para pintar
//   un número que nadie distingue de su vecino. El servidor además recuerda
//   el último cálculo: si llega lo mismo, responde sin ejecutar.
//
// DÓNDE CORRE
//
//   En el Diseñador y en la Vista Previa por igual: el lienzo del Diseñador
//   ya enseña valores en vivo, y ver la función funcionar mientras se diseña
//   es la mitad de la gracia. Dentro de un faceplate también: `resolver`
//   traduce `param:x` al tag de la instancia antes de leerlo.
//
// SI EL SERVIDOR FALLA
//
//   Se deja el último valor que se tuvo y se apunta el error (el Inspector
//   podrá enseñarlo). Nunca se pinta un cero de mentira: sin valor todavía
//   el widget ve `null`, que es lo que ve con un tag que no se lee.
// =========================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HmiWidget } from '../../../models/widget';
import type { PlcVariable } from '../../../models/plc';
import {
  leerFunciones,
  NOMBRE_PRINCIPAL,
  SALIDA_PRINCIPAL,
  type FuncionSalida,
} from '../../../utils/funciones';
import { evaluarFuncion } from '../../../services/funcionesApi';

const ESPERA_MS = 250;

type Resolver = (variableId: string | null | undefined) => PlcVariable | undefined;

/** El tipo de dato que mejor describe un valor calculado. */
function tipoDe(v: unknown): PlcVariable['type'] {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  return 'string';
}

/** Lo que el código recibe como valor de una entrada. */
function valorDe(v: PlcVariable | undefined): unknown {
  if (!v) return null;
  const x = v.value;
  return x === undefined ? null : x;
}

interface SalidaActiva {
  clave: string;
  nombre: string;
  f: FuncionSalida;
}

/** Las salidas que de verdad tienen código. */
function salidasActivas(widget: HmiWidget): SalidaActiva[] {
  const cfg = leerFunciones(widget);
  if (!cfg.activo) return [];
  const salida: SalidaActiva[] = [];
  for (const [clave, f] of Object.entries(cfg.porSalida)) {
    if (!f.expresion.trim()) continue;
    salida.push({ clave, nombre: clave === SALIDA_PRINCIPAL ? NOMBRE_PRINCIPAL : clave, f });
  }
  return salida;
}

export interface FuncionesEnVivo {
  variable: PlcVariable | undefined;
  enlaces: Record<string, PlcVariable | undefined> | undefined;
  /** Último error por salida (clave), para el Inspector. */
  errores: Record<string, string>;
}

export function useFuncionesEnVivo(
  widget: HmiWidget,
  variable: PlcVariable | undefined,
  enlaces: Record<string, PlcVariable | undefined> | undefined,
  resolver: Resolver | undefined
): FuncionesEnVivo {
  const salidas = useMemo(() => salidasActivas(widget), [widget]);
  const hay = salidas.length > 0;

  // Las entradas de todas las salidas, con su valor de ahora. La firma es
  // lo que decide si hay que volver a pedir: cambia solo cuando cambia un
  // valor de entrada o el código.
  const peticiones = useMemo(() => {
    if (!hay) return [];
    return salidas.map((s) => {
      const entradas: Record<string, unknown> = {};
      for (const e of s.f.entradas) {
        const n = e.nombre.trim();
        if (!n) continue;
        entradas[n] = e.variableId
          ? valorDe(resolver ? resolver(e.variableId) : undefined)
          : null;
      }
      return {
        widget_id: widget.id,
        salida_clave: s.clave,
        salida: s.nombre,
        codigo: s.f.expresion,
        entradas,
        internas: s.f.internas
          .filter((i) => i.nombre.trim())
          .map((i) => ({ nombre: i.nombre.trim(), tipo: i.tipo })),
      };
    });
    // `resolver` cambia de identidad por render en algunos padres; la firma
    // de abajo es la que evita trabajo de más.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salidas, widget.id, resolver, hay]);

  const firma = useMemo(() => (hay ? JSON.stringify(peticiones) : ''), [peticiones, hay]);

  const [valores, setValores] = useState<Record<string, unknown>>({});
  const [errores, setErrores] = useState<Record<string, string>>({});
  const reloj = useRef<number | null>(null);
  const ultimaFirma = useRef('');
  const vivo = useRef(true);
  // Lo ÚLTIMO calculado, para que el envío programado mande lo de ahora y
  // no lo que había cuando se programó: en 250 ms pueden llegar tres
  // lecturas, y la que importa es la tercera.
  const ultimo = useRef({ peticiones, firma });
  ultimo.current = { peticiones, firma };

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
      if (reloj.current !== null) window.clearTimeout(reloj.current);
    };
  }, []);

  useEffect(() => {
    if (!hay || !firma || firma === ultimaFirma.current) return;
    // Ya hay un envío en camino: cuando dispare leerá `ultimo`, que ya
    // incluye este cambio.
    if (reloj.current !== null) return;

    reloj.current = window.setTimeout(() => {
      reloj.current = null;
      const { peticiones: lote, firma: enviada } = ultimo.current;
      ultimaFirma.current = enviada;
      for (const p of lote) {
        void evaluarFuncion(p)
          .then((r) => {
            if (!vivo.current) return;
            if (r.exito) {
              setValores((v) =>
                v[p.salida_clave] === r.valor ? v : { ...v, [p.salida_clave]: r.valor }
              );
              setErrores((e) => (e[p.salida_clave] ? { ...e, [p.salida_clave]: '' } : e));
            } else {
              const texto = r.linea ? `Línea ${r.linea}: ${r.error}` : r.error;
              setErrores((e) =>
                e[p.salida_clave] === texto ? e : { ...e, [p.salida_clave]: texto }
              );
            }
          })
          .catch((err: any) => {
            if (!vivo.current) return;
            const texto = err?.message ?? 'No se pudo evaluar la función.';
            setErrores((e) =>
              e[p.salida_clave] === texto ? e : { ...e, [p.salida_clave]: texto }
            );
          });
      }
    }, ESPERA_MS);
  }, [firma, hay]);

  return useMemo<FuncionesEnVivo>(() => {
    if (!hay) return { variable, enlaces, errores };

    let v = variable;
    let en = enlaces;
    for (const s of salidas) {
      if (!(s.clave in valores)) continue;
      const valor = valores[s.clave] as PlcVariable['value'];
      const base: PlcVariable | undefined = s.clave === SALIDA_PRINCIPAL ? variable : enlaces?.[s.clave];
      const calculada: PlcVariable = {
        id: base?.id ?? `${widget.id}|ƒ:${s.nombre}`,
        name: base?.name ?? s.nombre,
        type: tipoDe(valor),
        value: valor,
        unit: base?.unit,
        selected: base?.selected ?? false,
      };
      if (s.clave === SALIDA_PRINCIPAL) v = calculada;
      else en = { ...(en ?? {}), [s.clave]: calculada };
    }
    return { variable: v, enlaces: en, errores };
  }, [hay, salidas, valores, variable, enlaces, errores, widget.id]);
}
