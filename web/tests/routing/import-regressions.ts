// Executed by the isolated routing fixture. Production components and archive worker
// stay intact; only the worker persistence boundary and official network are faulted.
(() => {
  // Install before SvelteKit creates PublicClient: it captures fetch once, so a
  // later window.fetch patch alone cannot observe automatic saved-job recovery.
  const boundaryFetch = window.fetch.bind(window);
  let retainedJobRequests = 0;
  let completedJobReads = 0;
  let completedJobCancels = 0;
  window.fetch = async (request, options) => {
    const url = new URL(
      request instanceof Request ? request.url : String(request),
      location.origin
    );
    if (
      url.origin === location.origin &&
      url.pathname === '/api/public/jobs/synthetic-retained-recovery-job'
    ) {
      retainedJobRequests++;
      return Response.json({ detail: 'Synthetic saved job is unavailable' }, { status: 404 });
    }
    if (
      url.origin === location.origin &&
      url.pathname.startsWith('/api/public/jobs/synthetic-completed-preflight-job')
    ) {
      if (url.pathname.endsWith('/result'))
        return Response.json({ records_document: {
          schema_version: 1, exported_at: '2026-01-01T00:00:00Z', records: []
        } });
      if (url.pathname.endsWith('/cancel')) completedJobCancels++;
      else completedJobReads++;
      return Response.json({
        id: 'synthetic-completed-preflight-job',
        status: 'completed',
        message: 'Synthetic prior collection completed.',
        records: 0,
        pages: 1
      });
    }
    return boundaryFetch(request, options);
  };
  type Context = {
    navigate(slug: 'history' | 'backup' | 'profiles' | 'statistics' | 'privacy'): Promise<void>;
    archiveCall<T>(method: string, ...args: unknown[]): Promise<T>;
    until(check: () => unknown, description: string): Promise<void>;
    log(message: string): void;
    clickButton(label: string, scope?: ParentNode): void;
    input(
      element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
      value: string
    ): void;
    activeProfile(): HTMLSelectElement;
    findButton(label: string, scope?: ParentNode): HTMLButtonElement | undefined;
    main(): HTMLElement;
    driveListCount(): number;
    holdDrivePass(): Promise<() => void>;
  };
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }

  async function run(context: Context) {
    const {
      navigate,
      archiveCall,
      until,
      log,
      clickButton,
      input,
      activeProfile,
      findButton,
      main
    } = context;
    await navigate('history');
    if (!document.querySelector('#import-panel')) clickButton('Import history');
    await until(() => document.querySelector('#import-panel'), 'import regression panel');
    clickButton('Captured request');
    await until(() => document.querySelector('textarea'), 'import regression capture input');
    const capture =
      'POST https://gf2-gacha-record-us.sunborngame.com/list?u=synthetic-routing-account&game_channel_id=1&type_id=1 HTTP/1.1\r\nHost: gf2-gacha-record-us.sunborngame.com\r\nAuthorization: synthetic-routing-credential\r\nContent-Length: 8\r\n\r\nserver=1';
    const before = JSON.stringify(await archiveCall('exportState'));
    const originalPostMessage = Worker.prototype.postMessage;
    const originalFetch = window.fetch;
    const originalCreateURL = URL.createObjectURL;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    let failNextWrite = true;
    let failHeldWrite: (() => void) | undefined;
    let gameRequests = 0;
    let cancelNextCapture = false;
    let cancellationPending = false;
    let downloaded: Blob | undefined;
    let alternateJobKey: string | undefined;
    let preflightJobKey: string | undefined;
    let releasePreflightDrive: (() => void) | undefined;
    Worker.prototype.postMessage = function (
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions
    ) {
      const request = message as { id?: number; method?: string };
      if (request.method === 'importRecords' && failNextWrite) {
        failNextWrite = false;
        failHeldWrite = () =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: {
                id: request.id,
                error: 'Synthetic persistence quota failure',
                errorName: 'QuotaExceededError'
              }
            })
          );
        return;
      }
      Reflect.apply(
        originalPostMessage,
        this,
        transfer === undefined ? [message] : [message, transfer]
      );
    };
    window.fetch = async (request, options = {}) => {
      const url = new URL(
        request instanceof Request ? request.url : String(request),
        location.origin
      );
      if (url.hostname === 'gf2-gacha-record-us.sunborngame.com') {
        gameRequests++;
        if (cancelNextCapture) {
          cancellationPending = true;
          return new Promise<Response>((_resolve, reject) => {
            const cancelled = () => reject(new DOMException('Aborted', 'AbortError'));
            if (options.signal?.aborted) cancelled();
            else options.signal?.addEventListener('abort', cancelled, { once: true });
          });
        }
      }
      return originalFetch(request, options);
    };
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob) downloaded = blob;
      return originalCreateURL(blob);
    };
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) originalAnchorClick.call(this);
    };
    try {
      input(document.querySelector('textarea'), capture);
      await until(
        () => findButton('Fetch accessible history')?.matches(':enabled'),
        'regression collection enabled'
      );
      clickButton('Fetch accessible history');
      await until(() => failHeldWrite, 'durable import write held');
      assert(
        activeProfile().disabled,
        'Import retains destination ownership while persistence is pending'
      );
      const discard = findButton('Discard collected copy');
      assert(
        !discard || discard.matches(':disabled'),
        'Pending persistence cannot discard records or release sync ownership'
      );
      assert(document.querySelector('textarea')?.value === '', 'Submitted capture is cleared');
      assert(failHeldWrite, 'A persistence request is awaiting its synthetic failure');
      failHeldWrite();
      await until(
        () => findButton('Retry saving records')?.matches(':enabled') && !activeProfile().disabled,
        'failed write retains recovery controls and releases operation'
      );
      assert(
        JSON.stringify(await archiveCall('exportState')) === before,
        'Failed persistence leaves the archive unchanged'
      );
      clickButton('Download collected records');
      await until(() => downloaded, 'sanitized collected records download');
      const text = await downloaded!.text();
      const records = JSON.parse(text);
      assert(
        Array.isArray(records.records) && records.records.length > 0,
        'Recovery download contains collected records'
      );
      assert(
        !text.includes('synthetic-routing-credential') && !text.includes('Authorization:'),
        'Recovery download excludes capture credentials'
      );
      const originalProfile = activeProfile().value;
      // Use a never-selected profile: JobMemory must not already have cached a
      // missing job ID before this synthetic reload-recovery value is seeded.
      const alternate = await archiveCall<{ id: string }>(
        'createProfile',
        'Retained recovery alternate'
      );
      alternateJobKey = `gfl2-stable.job.${alternate.id}`;
      localStorage.setItem(alternateJobKey, 'synthetic-retained-recovery-job');
      await until(
        () => [...activeProfile().options].some((option) => option.value === alternate.id),
        'alternate recovery profile appears'
      );
      const jobRequestsBeforeSwitch = retainedJobRequests;
      input(activeProfile(), alternate.id);
      await until(
        () =>
          activeProfile().value === alternate.id &&
          !activeProfile().disabled &&
          !main().querySelector('[aria-busy="true"]'),
        'alternate profile settles with unsaved records retained'
      );
      assert(
        retainedJobRequests === jobRequestsBeforeSwitch,
        'Switching profiles must not resume another saved job while collected records are unsaved'
      );
      assert(
        !findButton('Check saved job'),
        'Another saved job cannot replace unsaved collected records'
      );
      assert(
        findButton('Retry saving records')?.matches(':enabled'),
        'Switching profiles preserves saving recovery'
      );
      const previousDownload = downloaded;
      clickButton('Download collected records');
      await until(
        () => downloaded !== previousDownload,
        'original records remain downloadable on another profile'
      );
      assert(
        (await downloaded!.text()) === text,
        'Profile switching changed the original unsaved collection'
      );
      input(activeProfile(), originalProfile);
      await until(
        () =>
          activeProfile().value === originalProfile &&
          !activeProfile().disabled &&
          !main().querySelector('[aria-busy="true"]'),
        'original collection destination restored'
      );
      log(
        'PASS unsaved collection survives profile switching without automatically resuming another saved job'
      );
      const collectedRequests = gameRequests;
      clickButton('Retry saving records');
      await until(
        () =>
          !findButton('Retry saving records') &&
          !activeProfile().disabled &&
          main().textContent?.includes('Import complete'),
        'retained collection commits through production worker'
      );
      assert(
        gameRequests === collectedRequests,
        'Saving retry never recollects or resubmits credentials'
      );
      log(
        'PASS pending-save ownership, failed-save recovery download, and storage retry without recollection'
      );

      const previousJobProfile = await archiveCall<{ id: string }>(
        'createProfile',
        'Preflight cancellation'
      );
      preflightJobKey = `gfl2-stable.job.${previousJobProfile.id}`;
      localStorage.setItem(preflightJobKey, 'synthetic-completed-preflight-job');
      await until(
        () => [...activeProfile().options].some((option) => option.value === previousJobProfile.id),
        'prior-job regression profile appears'
      );
      input(activeProfile(), previousJobProfile.id);
      await until(
        () =>
          completedJobReads > 0 &&
          !activeProfile().disabled &&
          main().textContent?.includes('Synthetic prior collection completed.'),
        'previous server job completes'
      );
      releasePreflightDrive = await context.holdDrivePass();
      const heldLists = context.driveListCount();
      const previousJobReads = completedJobReads;
      const previousGameRequests = gameRequests;
      input(document.querySelector('textarea'), capture);
      const unsubmittedCapture = document.querySelector('textarea')!.value;
      clickButton('Fetch accessible history');
      await until(
        () =>
          main().textContent?.includes('Waiting for archive sync') &&
          findButton('Stop collection')?.matches(':enabled'),
        'new import waits behind Drive with cancellation available'
      );
      clickButton('Stop collection');
      await until(
        () =>
          !activeProfile().disabled && main().textContent?.includes('cancelled before it started'),
        'preflight cancellation releases operation ownership'
      );
      assert(
        document.querySelector('textarea')?.value === unsubmittedCapture,
        'Preflight cancellation preserves the unsubmitted capture'
      );
      assert(
        completedJobCancels === 0 && completedJobReads === previousJobReads,
        'Cancelling a new import must neither cancel nor poll the previous completed job'
      );
      releasePreflightDrive();
      releasePreflightDrive = undefined;
      await navigate('backup');
      await until(
        () => findButton('Sync now')?.matches(':enabled'),
        'held Drive pass finishes after cancellation'
      );
      clickButton('Sync now');
      await until(
        () =>
          context.driveListCount() > heldLists &&
          !activeProfile().disabled &&
          main().textContent?.includes('synced to Google Drive'),
        'manual Drive sync succeeds after cancelled preflight'
      );
      assert(
        gameRequests === previousGameRequests,
        'Cancelled preflight cannot start collection after Drive resumes'
      );
      await navigate('history');
      assert(
        document.querySelector('textarea')?.value === unsubmittedCapture,
        'Late preflight completion cannot clear the capture'
      );
      input(activeProfile(), originalProfile);
      await until(
        () =>
          activeProfile().value === originalProfile &&
          !activeProfile().disabled &&
          !main().querySelector('[aria-busy="true"]'),
        'original profile restored after preflight cancellation'
      );
      log(
        'PASS cancelled preflight preserves capture, ignores a previous completed job, and releases its Drive pause'
      );

      cancelNextCapture = true;
      input(document.querySelector('textarea'), capture);
      clickButton('Fetch accessible history');
      await until(() => cancellationPending, 'cancellable official request pending');
      clickButton('Stop collection');
      await until(
        () => !activeProfile().disabled && main().textContent?.includes('Collection stopped'),
        'cancellation releases import ownership'
      );
      assert(
        !findButton('Retry saving records'),
        'Cancellation before records does not invent a retained result'
      );
      log(
        'PASS cancellation before first response releases import ownership and leaves saved history available'
      );
    } finally {
      Worker.prototype.postMessage = originalPostMessage;
      window.fetch = originalFetch;
      URL.createObjectURL = originalCreateURL;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
      if (alternateJobKey) localStorage.removeItem(alternateJobKey);
      if (preflightJobKey) localStorage.removeItem(preflightJobKey);
      releasePreflightDrive?.();
    }
  }
  Object.assign(window, { runImportRegressions: run });
})();
