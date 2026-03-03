import { describe, it, expect } from 'vitest';
import { setNiError } from '../mocks/neural-interface.mock.js';
import {
  handleBrowserClick,
  handleBrowserFill,
  handleBrowserType,
  handleBrowserHover,
  handleBrowserSelect,
  handleBrowserPress,
  handleBrowserScroll,
  handleBrowserUpload,
} from '@mcp/tools/browser-interact.js';

describe('browser_click', () => {
  it('clicks an element successfully', async () => {
    const res = await handleBrowserClick({ selector: 'button.submit' });
    expect(res.content[0].text).toContain('Clicked "button.submit"');
  });

  it('forwards NI error on click failure', async () => {
    setNiError('Element not found');
    const res = await handleBrowserClick({ selector: 'button.missing' });
    expect(res.content[0].text).toContain('Element not found');
  });
});

describe('browser_fill', () => {
  it('fills an input successfully', async () => {
    const res = await handleBrowserFill({ selector: 'input[name="email"]', value: 'test@example.com' });
    expect(res.content[0].text).toContain('Filled "input[name="email"]"');
    expect(res.content[0].text).toContain('test@example.com');
  });

  it('forwards NI error on fill failure', async () => {
    setNiError('Input is disabled');
    const res = await handleBrowserFill({ selector: '#email', value: 'test' });
    expect(res.content[0].text).toContain('Input is disabled');
  });
});

describe('browser_type', () => {
  it('types into a selector successfully', async () => {
    const res = await handleBrowserType({ selector: '#search', text: 'hello world' });
    expect(res.content[0].text).toContain('Typed "hello world"');
    expect(res.content[0].text).toContain('"#search"');
  });

  it('types into focused element when no selector', async () => {
    const res = await handleBrowserType({ text: 'hello world' });
    expect(res.content[0].text).toContain('Typed "hello world"');
    expect(res.content[0].text).toContain('focused element');
  });

  it('forwards NI error on type failure', async () => {
    setNiError('Element detached');
    const res = await handleBrowserType({ selector: '#input', text: 'test' });
    expect(res.content[0].text).toContain('Element detached');
  });
});

describe('browser_hover', () => {
  it('hovers over an element successfully', async () => {
    const res = await handleBrowserHover({ selector: '.dropdown-trigger' });
    expect(res.content[0].text).toContain('Hovered over ".dropdown-trigger"');
  });

  it('forwards NI error on hover failure', async () => {
    setNiError('Element not visible');
    const res = await handleBrowserHover({ selector: '.hidden' });
    expect(res.content[0].text).toContain('Element not visible');
  });
});

describe('browser_select', () => {
  it('selects an option successfully', async () => {
    const res = await handleBrowserSelect({ selector: 'select#country', value: 'US' });
    expect(res.content[0].text).toContain('Selected "US" in "select#country"');
  });

  it('forwards NI error on select failure', async () => {
    setNiError('Option not found');
    const res = await handleBrowserSelect({ selector: '#country', value: 'XX' });
    expect(res.content[0].text).toContain('Option not found');
  });
});

describe('browser_press', () => {
  it('presses a key successfully', async () => {
    const res = await handleBrowserPress({ key: 'Enter' });
    expect(res.content[0].text).toContain('Pressed "Enter"');
  });

  it('forwards NI error on press failure', async () => {
    setNiError('Page navigated away');
    const res = await handleBrowserPress({ key: 'Escape' });
    expect(res.content[0].text).toContain('Page navigated away');
  });
});

describe('browser_scroll', () => {
  it('scrolls with default distance', async () => {
    const res = await handleBrowserScroll({ direction: 'down' });
    expect(res.content[0].text).toContain('Scrolled down 500px in page');
  });

  it('scrolls with custom distance', async () => {
    const res = await handleBrowserScroll({ direction: 'up', distance: 1200 });
    expect(res.content[0].text).toContain('Scrolled up 1200px');
  });

  it('scrolls within a specific element', async () => {
    const res = await handleBrowserScroll({ direction: 'down', selector: '[role="feed"]' });
    expect(res.content[0].text).toContain('"[role="feed"]"');
  });

  it('forwards NI error on scroll failure', async () => {
    setNiError('Scroll container not found');
    const res = await handleBrowserScroll({ direction: 'down' });
    expect(res.content[0].text).toContain('Scroll container not found');
  });
});

describe('browser_upload', () => {
  it('uploads files successfully', async () => {
    const res = await handleBrowserUpload({
      selector: 'input[type="file"]',
      filePaths: ['/tmp/image1.png', '/tmp/image2.jpg'],
    });
    expect(res.content[0].text).toContain('Uploaded 2 file(s)');
  });

  it('forwards NI error on upload failure', async () => {
    setNiError('File input not found');
    const res = await handleBrowserUpload({
      selector: 'input[type="file"]',
      filePaths: ['/tmp/test.png'],
    });
    expect(res.content[0].text).toContain('File input not found');
  });
});
