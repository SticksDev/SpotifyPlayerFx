import type { ReactNode } from "react";
import { h } from "../lib/jsx";

export function Row({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
	return (
		<div className="pfx-row">
			<div className="pfx-row-text">
				<div className="pfx-row-label">{label}</div>
				{hint && <div className="pfx-row-hint">{hint}</div>}
			</div>
			{children}
		</div>
	);
}

interface SwitchRowProps {
	label: string;
	hint?: string;
	on: boolean;
	disabled?: boolean;
	onChange(on: boolean): void;
}

export function SwitchRow({ label, hint, on, disabled, onChange }: SwitchRowProps) {
	return (
		<Row label={label} hint={hint}>
			<button
				type="button"
				className="pfx-switch"
				role="switch"
				aria-checked={on}
				aria-label={label}
				disabled={disabled}
				onClick={() => onChange(!on)}
			/>
		</Row>
	);
}

export function Segmented({ label, options, value, onChange }: { label: string; options: string[]; value: number; onChange(i: number): void }) {
	return (
		<div className="pfx-seg" role="group" aria-label={label}>
			{options.map((text, i) => (
				<button key={i} type="button" aria-pressed={value === i} onClick={() => onChange(i)}>
					{text}
				</button>
			))}
		</div>
	);
}
