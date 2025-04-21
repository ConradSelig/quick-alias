const { Plugin, Notice, PluginSettingTab, Setting } = require('obsidian');

// Simple debounce function to limit frequent calls
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Default settings
const DEFAULT_SETTINGS = {
    fileRegex: '[0-9]{4}\\-[0-9]{2}\\-[0-9]{2}', // Matches YYYY-MM-DD
    showUpdateNotice: true,
    debounceTimeout: 1000 // Default 1000ms (1 second)
};

module.exports = class QuickAliasPlugin extends Plugin {
    settings = DEFAULT_SETTINGS;

    async onload() {
        try {
            await this.loadSettings();
            this.addSettingTab(new QuickAliasSettingTab(this.app, this));

            // Monitor file changes with debounced processing
            this.registerEvent(
                this.app.workspace.on('file-open', (file) => {
                    if (file && file.extension === 'md') {
                        this.processFile(file);
                    }
                })
            );

            const debouncedProcessFile = debounce((file) => {
                if (file && file.extension === 'md' && file === this.app.workspace.getActiveFile()) {
                    this.processFile(file);
                }
            }, this.settings.debounceTimeout);

            this.registerEvent(
                this.app.vault.on('modify', debouncedProcessFile)
            );

            console.log('Quick Alias: Plugin loaded');
            new Notice('Quick Alias plugin loaded successfully');
        } catch (error) {
            console.error('Quick Alias: Failed to initialize plugin:', error);
            new Notice('Failed to initialize Quick Alias plugin. Check console for details.');
        }
    }

    async processFile(file) {
        try {
            // Check if filename matches regex
            const regex = new RegExp(`^${this.settings.fileRegex}$`);
            if (!file.basename.match(regex)) {
                return;
            }

            const content = await this.app.vault.read(file);
            const aliasMap = this.extractAliases(content);

            if (Object.keys(aliasMap).length > 0) {
                let updatedCount = 0;
                for (const [targetNote, aliases] of Object.entries(aliasMap)) {
                    const targetFile = this.app.metadataCache.getFirstLinkpathDest(targetNote, file.path);
                    if (targetFile && targetFile.extension === 'md') {
                        await this.updateFrontmatter(targetFile, aliases);
                        updatedCount++;
                    } else {
                        console.log(`Quick Alias: Skipped alias update for "${targetNote}" (note not found)`);
                    }
                }
                if (updatedCount > 0 && this.settings.showUpdateNotice) {
                    new Notice(`Updated aliases in ${updatedCount} referenced note(s).`);
                }
            }
        } catch (error) {
            console.error('Quick Alias: Error processing file:', file.path, error);
            new Notice(`Error processing file ${file.basename}: ${error.message}`);
        }
    }

    extractAliases(content) {
        const aliasRegex = /\[\[(.*?)(?:\|(.*?))?\]\]/g;
        const aliasMap = {};
        let match;

        while ((match = aliasRegex.exec(content)) !== null) {
            const targetNote = match[1].trim();
            const alias = match[2]?.trim();
            if (alias && targetNote) {
                if (!aliasMap[targetNote]) {
                    aliasMap[targetNote] = new Set();
                }
                aliasMap[targetNote].add(alias.toLowerCase());
            }
        }

        // Convert Sets to sorted arrays
        for (const note in aliasMap) {
            aliasMap[note] = Array.from(aliasMap[note]).sort();
        }

        return aliasMap;
    }

    async updateFrontmatter(file, aliases) {
        try {
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                // Convert existing aliases to lowercase for comparison
                const existingAliases = (frontmatter['aliases'] || []).map(alias => alias.toLowerCase());
                // Combine and deduplicate, keeping all in lowercase
                frontmatter['aliases'] = [...new Set([
                    ...existingAliases,
                    ...aliases
                ])].sort();
            });
        } catch (error) {
            console.error('Quick Alias: Error updating frontmatter for file:', file.path, error);
            throw error; // Rethrow to be caught by processFile
        }
    }

    async loadSettings() {
        try {
            const data = await this.loadData();
            this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
            // Ensure debounceTimeout is within range
            this.settings.debounceTimeout = Math.max(1000, Math.min(5000, this.settings.debounceTimeout || DEFAULT_SETTINGS.debounceTimeout));
        } catch (error) {
            console.error('Quick Alias: Error loading settings:', error);
            this.settings = Object.assign({}, DEFAULT_SETTINGS);
            new Notice('Failed to load Quick Alias settings. Using defaults.');
        }
    }

    async saveSettings() {
        try {
            await this.saveData(this.settings);
        } catch (error) {
            console.error('Quick Alias: Error saving settings:', error);
            new Notice('Failed to save Quick Alias settings.');
        }
    }
};

class QuickAliasSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Quick Alias Settings' });

        new Setting(containerEl)
            .setName('File name regex')
            .setDesc('Regular expression to match file names (without extension). Default: [0-9]{4}\\-[0-9]{2}\\-[0-9]{2} (YYYY-MM-DD).')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.fileRegex)
                .setValue(this.plugin.settings.fileRegex)
                .onChange(async (value) => {
                    try {
                        new RegExp(value);
                        this.plugin.settings.fileRegex = value || DEFAULT_SETTINGS.fileRegex;
                        await this.plugin.saveSettings();
                    } catch (error) {
                        new Notice(`Invalid regex: ${error.message}`);
                    }
                }));

        new Setting(containerEl)
            .setName('Show update notice')
            .setDesc('Show a notice when aliases are updated in the frontmatter of referenced notes.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showUpdateNotice)
                .onChange(async (value) => {
                    this.plugin.settings.showUpdateNotice = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Debounce timeout (ms)')
            .setDesc('Time to wait before processing file modifications (1000-5000 ms).')
            .addText(text => text
                .setPlaceholder(String(DEFAULT_SETTINGS.debounceTimeout))
                .setValue(String(this.plugin.settings.debounceTimeout))
                .onChange(async (value) => {
                    const numValue = parseInt(value, 10);
                    if (isNaN(numValue) || numValue < 1000 || numValue > 5000) {
                        new Notice('Debounce timeout must be a number between 1000 and 5000.');
                        return;
                    }
                    this.plugin.settings.debounceTimeout = numValue;
                    await this.plugin.saveSettings();
                    new Notice('Debounce timeout updated. Restart the plugin to apply.');
                }));
    }
}