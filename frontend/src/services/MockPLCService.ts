import { PlcVariable } from '../models/plc';

// Emulated PLC data source. Generates realistic-looking random values
// on a configurable interval. No real network / PLC communication.

const seedVariables = (): PlcVariable[] => [
{ id: 'motor_1', name: 'Motor_1', type: 'bool', value: true, selected: true },
{
  id: 'motor_2',
  name: 'Motor_2',
  type: 'bool',
  value: false,
  selected: true
},
{
  id: 'motor_3',
  name: 'Motor_3',
  type: 'bool',
  value: true,
  selected: false
},
{
  id: 'temperatura',
  name: 'Temperatura',
  type: 'double',
  value: 25.4,
  unit: '°C',
  selected: true
},
{
  id: 'presion',
  name: 'Presion',
  type: 'double',
  value: 4.2,
  unit: 'bar',
  selected: true
},
{
  id: 'nivel',
  name: 'Nivel',
  type: 'int',
  value: 78,
  unit: '%',
  selected: true
},
{
  id: 'velocidad',
  name: 'Velocidad',
  type: 'int',
  value: 1530,
  unit: 'RPM',
  selected: true
},
{
  id: 'estado_bomba',
  name: 'Estado_Bomba',
  type: 'bool',
  value: true,
  selected: true
},
{
  id: 'estado_valvula',
  name: 'Estado_Valvula',
  type: 'bool',
  value: false,
  selected: true
},
{
  id: 'sensor_1',
  name: 'Sensor_1',
  type: 'double',
  value: 12.7,
  unit: 'mV',
  selected: false
},
{
  id: 'sensor_2',
  name: 'Sensor_2',
  type: 'double',
  value: 8.9,
  unit: 'mV',
  selected: false
},
{
  id: 'sensor_3',
  name: 'Sensor_3',
  type: 'double',
  value: 15.1,
  unit: 'mV',
  selected: false
},
{
  id: 'caudal',
  name: 'Caudal',
  type: 'double',
  value: 42.5,
  unit: 'l/min',
  selected: true
},
{
  id: 'rpm',
  name: 'RPM',
  type: 'int',
  value: 2450,
  unit: 'RPM',
  selected: true
},
{
  id: 'voltaje',
  name: 'Voltaje',
  type: 'double',
  value: 230.1,
  unit: 'V',
  selected: true
},
{
  id: 'corriente',
  name: 'Corriente',
  type: 'double',
  value: 8.4,
  unit: 'A',
  selected: true
},
{
  id: 'alarma_1',
  name: 'Alarma_1',
  type: 'bool',
  value: false,
  selected: true
},
{
  id: 'alarma_2',
  name: 'Alarma_2',
  type: 'bool',
  value: false,
  selected: false
},
{
  id: 'produccion',
  name: 'Produccion',
  type: 'int',
  value: 1284,
  unit: 'uds',
  selected: true
},
{
  id: 'energia',
  name: 'Energia',
  type: 'double',
  value: 154.6,
  unit: 'kWh',
  selected: true
}];


const clamp = (n: number, min: number, max: number) =>
Math.min(max, Math.max(min, n));

const drift = (v: PlcVariable): PlcVariable['value'] => {
  switch (v.type) {
    case 'bool':
      // occasional toggle
      return Math.random() < 0.15 ? !(v.value as boolean) : v.value as boolean;
    case 'int':{
        const cur = v.value as number;
        const delta = Math.round((Math.random() - 0.5) * Math.max(4, cur * 0.03));
        return clamp(cur + delta, 0, cur > 100 ? cur * 2 : 100);
      }
    case 'double':{
        const cur = v.value as number;
        const delta = (Math.random() - 0.5) * Math.max(1, cur * 0.05);
        return Math.round((cur + delta) * 10) / 10;
      }
    case 'string':
      return v.value;
  }
};

type Listener = (vars: PlcVariable[]) => void;

class MockPLCServiceImpl {
  private variables: PlcVariable[] = seedVariables();
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private rate = 1000;
  private running = false;

  getVariables(): PlcVariable[] {
    return this.variables.map((v) => ({ ...v }));
  }

  setVariables(vars: PlcVariable[]) {
    this.variables = vars.map((v) => ({ ...v }));
    this.emit();
  }

  toggleSelected(id: string, selected: boolean) {
    this.variables = this.variables.map((v) =>
    v.id === id ? { ...v, selected } : v
    );
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getVariables());
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const snapshot = this.getVariables();
    this.listeners.forEach((l) => l(snapshot));
  }

  private tick = () => {
    this.variables = this.variables.map((v) => ({ ...v, value: drift(v) }));
    this.emit();
  };

  start(rate: number) {
    this.rate = rate;
    this.running = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(this.tick, this.rate);
  }

  setRate(rate: number) {
    if (this.rate === rate && this.running) return;
    this.rate = rate;
    if (this.running) this.start(rate);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const MockPLCService = new MockPLCServiceImpl();