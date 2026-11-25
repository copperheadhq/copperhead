// copperhead patch P1 (not upstream): local stand-in for the graphics-debug types used by the solvers' visualize() methods.

export interface Point {
  x: number;
  y: number;
  color?: string;
  label?: string;
  step?: number;
}

export interface Line {
  points: { x: number; y: number }[];
  strokeColor?: string;
  strokeWidth?: number;
  strokeDash?: string | number[];
  label?: string;
  step?: number;
}

export interface Rect {
  center: { x: number; y: number };
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  color?: string;
  label?: string;
  step?: number;
}

export interface Circle {
  center: { x: number; y: number };
  radius: number;
  fill?: string;
  stroke?: string;
  label?: string;
  step?: number;
}

export interface Text {
  x: number;
  y: number;
  text: string;
  color?: string;
  fontSize?: number;
  step?: number;
}

export interface Arrow {
  start: { x: number; y: number };
  end: { x: number; y: number };
  color?: string;
  step?: number;
}

export interface GraphicsObject {
  points?: Point[];
  lines?: Line[];
  rects?: Rect[];
  circles?: Circle[];
  texts?: Text[];
  arrows?: Arrow[];
  coordinateSystem?: 'cartesian' | 'screen';
  title?: string;
}
