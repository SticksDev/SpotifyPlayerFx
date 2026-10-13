// JSX factory over Spotify's own React (Spicetify.React). The bundler compiles
// <tag/> to h(...), resolved at call time so the global only needs to exist
// once something renders.
import type { ReactElement, ReactNode } from "react";

export function h(type: any, props?: any, ...children: ReactNode[]): ReactElement {
	return Spicetify.React.createElement(type, props, ...children);
}

export const Fragment = (props: { children?: ReactNode }) =>
	Spicetify.React.createElement(Spicetify.React.Fragment, null, props.children);
