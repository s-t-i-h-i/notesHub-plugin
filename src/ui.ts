import { ButtonComponent } from 'obsidian';

/**
 * Two-step confirmation for irreversible actions.
 *
 * Obsidian has no built-in confirm dialog, and a separate Modal for every
 * "are you sure?" would be heavier than the action itself. The first click
 * arms the button, the second fires it. Arming expires on its own — a
 * delete button left armed forever is a trap waiting for a stray click.
 */
export function armButton(
	button: ButtonComponent,
	label: string,
	confirmLabel: string,
	action: () => void,
): void {
	let armed = false;

	const disarm = () => {
		armed = false;
		button.buttonEl.removeClass('mod-warning');
		button.setButtonText(label);
	};

	button.setButtonText(label).onClick(() => {
		if (armed) {
			disarm();
			action();
			return;
		}

		armed = true;
		button.setWarning().setButtonText(confirmLabel);

		window.setTimeout(() => {
			// The button may have been removed if the tab was re-rendered.
			if (button.buttonEl.isConnected) disarm();
		}, 4000);
	});
}
