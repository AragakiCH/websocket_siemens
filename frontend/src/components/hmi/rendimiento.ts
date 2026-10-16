// =========================================================================
// hmi/rendimiento.ts
// Tres herramientas pequeñas para que una pantalla con muchos widgets no
// congele el navegador al aparecer.
//
// EL PROBLEMA, MEDIDO EN SÍNTOMAS
//   · Un widget importado en ZIP es un <iframe> con su propio documento,
//     CSS y JS. Treinta ZIP en una pantalla son treinta documentos que el
//     navegador construye EN EL MISMO HILO, de golpe, al montar la pantalla.
//     Mientras tanto no pinta nada: la sección se ve en blanco y los clics
//     esperan.
//   · Una vista general con nueve Tarjetas de Acceso monta nueve pantallas
//     completas a la vez —con sus ZIP, sus tendencias y sus alarmas— solo
//     para enseñar una miniatura del tamaño de una tarjeta.
//   · Y cada vez que llega una lectura del PLC, `toPlcVariables` fabricaba
//     objetos nuevos para TODAS las variables, así que todos los widgets se
//     redibujaban aunque su valor no hubiera cambiado.
//
// LAS TRES PIEZAS
//   1. `usarTurno()`     Un widget pesado no se monta cuando le toca en el
//                        árbol de React, sino cuando la cola le da turno:
//                        unos pocos por fotograma. Lo ligero aparece al
//                        instante; lo pesado va llegando sin bloquear.
//   2. `ContextoMiniatura` Dentro de una miniatura (Tarjeta de Acceso) los
//                        widgets caros se dibujan como una caja con su
//                        nombre: una miniatura de 200 px no es sitio para
//                        un iframe ni para una gráfica con histórico.
//   3. `indiceDe()`      Buscar una variable por id en O(1) en vez de
//                        recorrer la lista entera por cada widget y cada
//                        enlace en cada lectura.
// =========================================================================
import { createContext, useContext, useEffect, useState } from 'react';
import type { PlcVariable } from '../../models/plc';

// ─── 1 · La cola de montaje ──────────────────────────────────────

/** Cuántos turnos se conceden por tanda, y cada cuánto. */
const POR_TANDA = 2;
const CADA_MS = 40;

let cola: Array<() => void> = [];
let programado = false;

function despachar(): void {
  programado = false;
  const tanda = cola.splice(0, POR_TANDA);
  for (const conceder of tanda) conceder();
  if (cola.length > 0) programar();
}

function programar(): void {
  if (programado) return;
  programado = true;
  // `requestIdleCallback` cuando existe: así el primer pintado y los clics
  // van antes. Con tope, para que una página muy ocupada no deje la cola
  // esperando para siempre. Safari no lo tiene: se cae a un temporizador.
  const ric = (window as unknown as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(despachar, { timeout: CADA_MS * 3 });
  else window.setTimeout(despachar, CADA_MS);
}

/**
 * `true` cuando a este componente le ha tocado montarse.
 *
 * Mientras es `false`, el componente dibuja algo barato (su caja vacía) y
 * no construye nada pesado. En cuanto llega el turno, se monta de verdad.
 * Si se desmonta antes de que le toque, se retira de la cola.
 *
 * `inmediato` salta la cola (para lo que ya se montó una vez y vuelve).
 */
export function usarTurno(inmediato = false): boolean {
  const [listo, setListo] = useState(inmediato);
  useEffect(() => {
    if (listo) return;
    let vivo = true;
    const conceder = () => {
      if (vivo) setListo(true);
    };
    cola.push(conceder);
    programar();
    return () => {
      vivo = false;
      cola = cola.filter((c) => c !== conceder);
    };
  }, [listo]);
  return listo;
}

// ─── 2 · Miniatura ───────────────────────────────────────────────

/**
 * `true` dentro de una miniatura: una pantalla dibujada pequeña solo para
 * reconocerla (la Tarjeta de Acceso). Lo pone quien la dibuja; lo leen los
 * widgets caros para sustituirse por un marcador.
 */
export const ContextoMiniatura = createContext(false);

export function useEsMiniatura(): boolean {
  return useContext(ContextoMiniatura);
}

/**
 * Kinds que en una miniatura se dibujan como marcador y no de verdad: los
 * que montan un iframe, piden histórico, o consultan alarmas y recetas.
 */
export const KINDS_CAROS_EN_MINIATURA = new Set<string>([
  'custom:trend',
  'custom:alarmas',
  'custom:recetas-proceso',
]);

// ─── 3 · Índice de variables ─────────────────────────────────────

const indices = new WeakMap<PlcVariable[], Map<string, PlcVariable>>();

/**
 * `Map` id → variable para ESA lista, calculado una vez por lista.
 *
 * Va en un `WeakMap` sobre la propia lista: la Vista Previa, cada pantalla
 * empotrada y cada faceplate reciben la misma lista del AppStore, así que
 * comparten el índice en vez de construir uno cada uno.
 */
export function indiceDe(variables: PlcVariable[]): Map<string, PlcVariable> {
  let m = indices.get(variables);
  if (!m) {
    m = new Map();
    for (const v of variables) m.set(v.id, v);
    indices.set(variables, m);
  }
  return m;
}
