/** The desktop app serves its own page on the first of these that is free; each has its own page storage. */
export declare const DESKTOP_PORTS: readonly number[];
export declare const COMPANION_PORT: number;
export declare function companionPorts(harnessPort: number, options?: { packaged?: boolean }): { companion: number; control: number };
export declare function companionFolder(options: { home: string; harnessPort: number; packaged: boolean }): string;
export declare function companionLaunchPorts(harnessPort: number, options?: { packaged?: boolean; taken?: (port: number) => Promise<boolean> }): Promise<{ companion: number; control: number }>;
