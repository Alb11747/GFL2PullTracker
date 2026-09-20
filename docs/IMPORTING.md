# Importing a recruitment history

Use **Import** to select a collector export folder, supported history files, or
a compressed tracker backup. An unidentified legacy import needs an explicit
profile assignment. Import into a separate profile when account identity differs.
The game can expose a limited retention window, so collect regularly and retain
older exports. A partial capture cannot prove the start of a pity interval.

## Capture with Fiddler Classic on Windows

1. Install Fiddler Classic from the [official download page](https://www.telerik.com/download/fiddler).
2. Close unrelated applications that may send private traffic. In Fiddler,
   open **Tools → Options → HTTPS**, enable **Capture HTTPS CONNECTs** and
   **Decrypt HTTPS traffic**, and follow the certificate-trust prompts. Read
   Telerik's [HTTPS setup instructions](https://www.telerik.com/fiddler/fiddler-classic/documentation/configure-fiddler/decrypthttps).
3. Start capture, open Girls' Frontline 2, and open recruitment record history.
   Refresh a history page so that its request appears in Fiddler.
4. Select the request to the official game's recruitment record endpoint. Inspect
   its URL and query parameters rather than selecting unrelated login or payment
   traffic. Copy the full request URL or raw HTTP request that includes the
   history request's authentication parameters.
5. Paste it into the tracker's capture field. Review the two server-data choices
   before importing. The site explains when the capture will pass through its
   server. Do not save the request to an issue or share it with another person.
6. Stop Fiddler capture when finished. Disable HTTPS decryption and remove its
   interception certificate if you no longer need it, following Telerik's
   guidance. Close Fiddler to restore normal traffic routing.

If the browser cannot access the official service, choose the explicit server
fetch fallback or run the local Python collector and import its export. Do not
repeat an uncertain server submission automatically. An expired capture needs a
fresh history request. For unsupported ownership providers, file import and
browser-local storage remain usable while server recovery stays disabled.

The workflow was compared with the [Exilium import flow](https://exilium.xyz/import);
the instructions and interface here are maintained independently. Unsupported
Exilium export versions are rejected rather than guessed.
