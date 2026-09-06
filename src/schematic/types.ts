export interface Point {
  x: number;
  y: number;
}

export interface Pin {
  number: string;
  name: string;
  pos: Point;
  side: 'top' | 'bottom' | 'left' | 'right';
  netName?: string;
  componentRef: string;
}

export interface Component {
  ref: string;
  libId: string;
  pos: Point;
  bbox: {
    min: Point;
    max: Point;
  };
  pins: Pin[];
  value: string;
}

export interface Net {
  name: string;
  pins: Pin[];
}

export interface SchematicIR {
  components: Component[];
  nets: Net[];
}
