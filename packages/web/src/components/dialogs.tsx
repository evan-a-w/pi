import { useEffect, useRef, useState } from "preact/hooks";
import type { RpcExtensionUIRequest } from "../protocol.ts";
import { dialogQueue, respondToDialog, toasts } from "../state.ts";

function SelectDialog({ request }: { request: RpcExtensionUIRequest & { method: "select" } }) {
	return (
		<div class="dialog">
			<div class="dialog-title">{request.title}</div>
			<div class="dialog-options">
				{request.options.map((option) => (
					<button
						key={option}
						type="button"
						class="dialog-button"
						onClick={() => respondToDialog(request, { value: option })}
					>
						{option}
					</button>
				))}
			</div>
			<button type="button" class="dialog-cancel" onClick={() => respondToDialog(request, { cancelled: true })}>
				Cancel
			</button>
		</div>
	);
}

function ConfirmDialog({ request }: { request: RpcExtensionUIRequest & { method: "confirm" } }) {
	return (
		<div class="dialog">
			<div class="dialog-title">{request.title}</div>
			<div class="dialog-message">{request.message}</div>
			<div class="dialog-actions">
				<button type="button" class="dialog-button" onClick={() => respondToDialog(request, { confirmed: true })}>
					Yes
				</button>
				<button type="button" class="dialog-button" onClick={() => respondToDialog(request, { confirmed: false })}>
					No
				</button>
			</div>
		</div>
	);
}

function InputDialog({ request }: { request: RpcExtensionUIRequest & { method: "input" } }) {
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => inputRef.current?.focus(), []);
	return (
		<div class="dialog">
			<div class="dialog-title">{request.title}</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					respondToDialog(request, { value });
				}}
			>
				<input
					ref={inputRef}
					class="dialog-input"
					type="text"
					placeholder={request.placeholder ?? ""}
					value={value}
					onInput={(event) => setValue((event.target as HTMLInputElement).value)}
				/>
				<div class="dialog-actions">
					<button type="submit" class="dialog-button">
						Submit
					</button>
					<button
						type="button"
						class="dialog-button"
						onClick={() => respondToDialog(request, { cancelled: true })}
					>
						Cancel
					</button>
				</div>
			</form>
		</div>
	);
}

function EditorDialog({ request }: { request: RpcExtensionUIRequest & { method: "editor" } }) {
	const [value, setValue] = useState(request.prefill ?? "");
	return (
		<div class="dialog">
			<div class="dialog-title">{request.title}</div>
			<textarea
				class="dialog-textarea"
				rows={10}
				value={value}
				onInput={(event) => setValue((event.target as HTMLTextAreaElement).value)}
			/>
			<div class="dialog-actions">
				<button type="button" class="dialog-button" onClick={() => respondToDialog(request, { value })}>
					Submit
				</button>
				<button type="button" class="dialog-button" onClick={() => respondToDialog(request, { cancelled: true })}>
					Cancel
				</button>
			</div>
		</div>
	);
}

export function DialogHost() {
	const current = dialogQueue.value[0];
	if (!current) return null;
	return (
		<div class="dialog-overlay">
			{current.method === "select" && (
				<SelectDialog key={current.id} request={current as RpcExtensionUIRequest & { method: "select" }} />
			)}
			{current.method === "confirm" && (
				<ConfirmDialog key={current.id} request={current as RpcExtensionUIRequest & { method: "confirm" }} />
			)}
			{current.method === "input" && (
				<InputDialog key={current.id} request={current as RpcExtensionUIRequest & { method: "input" }} />
			)}
			{current.method === "editor" && (
				<EditorDialog key={current.id} request={current as RpcExtensionUIRequest & { method: "editor" }} />
			)}
		</div>
	);
}

export function ToastHost() {
	return (
		<div class="toasts">
			{toasts.value.map((toast) => (
				<div key={toast.id} class={`toast toast-${toast.kind}`}>
					{toast.message}
				</div>
			))}
		</div>
	);
}
