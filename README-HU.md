# Projektkezelő – telepítési leírás (Netlify, szinkronizálással)

Az alkalmazás **közös adaton dolgozik**: amit az egyik ember módosít, azt a többiek néhány másodpercen belül látják – akár a világ másik feléről is. Nincs szükség külön adatbázis-szolgáltatásra, a Netlify saját tárolóját (Netlify Blobs) használjuk.

---

## 1. A csomag tartalma

```
projekt/
├─ public/
│  └─ index.html          ← maga az alkalmazás (minden benne van)
├─ lib/
│  └─ core.mjs            ← a szerveroldali logika (közös)
├─ netlify/
│  └─ functions/
│     └─ board.mjs        ← Netlify-változat (Netlify Blobs)
├─ worker/
│  └─ index.mjs           ← Cloudflare-változat (D1 adatbázis)
├─ netlify.toml           ← Netlify beállítások
├─ wrangler.jsonc         ← Cloudflare beállítások
└─ package.json
```

Ugyanaz a csomag **két hoszthoz** is használható – vagy a Netlify, vagy a Cloudflare útvonalat kell követni. A logika mindkettőnél a `lib/core.mjs`, tehát nincs két külön verzió.

---

## 2. Telepítés

A `@netlify/blobs` csomagot telepíteni kell, ezért a **fájlok egyszerű behúzása (drag & drop) nem elegendő** – a függvény ilyenkor függőség nélkül kerül fel és hibát ad. Válaszd az alábbi két út egyikét.

### A) GitHub + Netlify – ajánlott

1. Töltsd fel a `projekt` mappa tartalmát egy GitHub-tárolóba.
2. Netlify → **Add new site → Import an existing project** → válaszd ki a tárolót.
3. Beállítások (a Netlify általában magától felismeri):
   - Build command: *(üresen hagyható)*
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
4. **Deploy**. A Netlify lefuttatja az `npm install` parancsot, és a végpont elérhető lesz.

Minden későbbi `git push` automatikusan új verziót tesz élesbe.

### B) Netlify CLI

```bash
npm install -g netlify-cli
cd projekt
npm install
netlify deploy --prod
```

### Ellenőrzés

Nyisd meg az oldalt és jelentkezz be. A fejlécben, a logó mellett **zöld pont** jelzi, hogy a szinkronizálás működik. Szürke pont = a szerver nem érhető el (ilyenkor az alkalmazás helyben tovább működik).

Közvetlen ellenőrzés terminálból:

```bash
curl -H "x-board-key: 3177b2ea96d8ffb966601c8f413b0ba3734355408ea0ca558a065829c83b6d83" \
     https://sajatdomain.hu/api/board?rev=-1
```

Válasz: `{"rev":0,"state":null}` (üres tábla) vagy a mentett adat.

---

## 2b. Telepítés Cloudflare Workers-re (ingyenes alternatíva)

A Cloudflare ingyenes csomagja **napi 100 000 kérést** enged, és a D1 adatbázis napi 100 000 írást – ez ehhez az alkalmazáshoz bőven elég, bankkártya nélkül.

1. **Adatbázis létrehozása:** Cloudflare dashboard → *Storage & Databases* → **D1** → *Create database* → név: `projektboard`. A létrehozás után másold ki a **Database ID**-t.
2. **ID beírása:** a `wrangler.jsonc` fájlban cseréld ki a `HIER_DIE_ID_AUS_DEM_CLOUDFLARE_DASHBOARD_EINTRAGEN` szöveget a másolt azonosítóra, és mentsd (GitHub-on: fájl → ceruza ikon → *Commit changes*).
3. **Projekt csatlakoztatása:** *Compute (Workers)* → *Create* → **Import a repository** → válaszd ki a GitHub-tárolót → *Deploy*. A beállításokat a `wrangler.jsonc` adja, nem kell semmit begépelni.
4. **E-mailhez** (választható): Worker → *Settings* → *Variables and Secrets* → `RESEND_API_KEY`, majd új deploy.
5. A cím `https://projektboard.<felhasználó>.workers.dev` lesz; saját domain a *Custom Domains* alatt köthető rá.

### Átköltözés Netlify-ról

Az adatok nem költöznek maguktól:

1. A régi címen lépj be tulajdonosként → profilkép → **Csapat kezelése** → *Biztonsági mentés* → letöltődik egy JSON-fájl.
2. Az új Cloudflare-címen lépj be ugyanazzal a fő belépővel → **Csapat kezelése** → *Mentés visszatöltése* → válaszd ki a fájlt.
3. A mentés **jelszavakat nem tartalmaz**: a munkatársaknak a *Csapat kezelése* ablakban adj újat.

Ugyanez a mentés használható rendszeres biztonsági másolatnak is.

### Melyik hoszt mit ad ingyen

| | Netlify | Cloudflare Workers |
|---|---|---|
| Kérések | kredit alapú, gyorsan fogy | napi 100 000 |
| Adattár | Netlify Blobs | D1 (napi 100 000 írás) |
| Beállítás | nincs extra lépés | egyszer be kell írni a D1 azonosítót |
| GitHub | igen | igen |

---

## 3. Belépési adatok

| | |
|---|---|
| Felhasználónév | `PeterKevin` |
| Jelszó | `peterkevin2026` |

A belépés 7 napig érvényes az adott böngészőben. Kijelentkezés: jobb felül a profilkép → **Kijelentkezés**.

A jelszó nem szerepel olvasható formában a fájlban, csak a `"felhasználónév:jelszó"` szöveg SHA-256 lenyomata. Ugyanez a lenyomat a végpont kulcsa is (`x-board-key` fejléc), így idegen nem tud a táblához írni.

### Belépési adatok módosítása

**Két helyen** kell átírni, és a kettőnek egyeznie kell:

1. `public/index.html`, a `16. Zugangsschutz` megjegyzés alatt:

```js
const AUTH_HASH = "…";   // SHA-256 a "név:jelszó" szövegből
const AUTH_ALT  = "…";   // tartalék: base64, megfordítva
const AUTH_DAYS = 7;     // meddig marad bejelentkezve
```

2. Netlify → **Project configuration → Environment variables**:

```
BOARD_KEY = <ugyanaz a SHA-256 érték>
```

Az új értékek előállítása (példa: `Anna:Titok123`):

```bash
echo -n "Anna:Titok123" | shasum -a 256    # → AUTH_HASH és BOARD_KEY
echo -n "Anna:Titok123" | base64 | rev     # → AUTH_ALT
```

Ha a `BOARD_KEY` nincs beállítva, a függvény a `board.mjs`-be írt tartalék értéket használja – jelszócserénél ezt is írd át. Környezeti változó módosítása után **újra kell deployolni**.

**Fontos:** a közös jelszó csapaton belüli használatra való. Személyenkénti hozzáféréshez a Netlify Identity vagy saját bejelentkezés kell.

---

## 3b. Szerepkörök, munkatársak és láthatóság

### Két szerepkör

- **Tulajdonos (admin):** mindent lát, ő hozza létre a munkatársakat, a projekteket és az oszlopokat, és ő dönti el, ki melyik feladatot láthatja.
- **Munkatárs:** csak a neki engedélyezett feladatokat látja. Azokon dolgozhat, jegyzetelhet, mellékletet tölthet fel, áthelyezheti őket, és új feladatot is létrehozhat. Projektet, oszlopot és felhasználót nem hozhat létre és nem törölhet.

### Munkatárs felvétele

Jobb felül a profilkép → **Csapat kezelése** → *+ Új munkatárs*. Meg kell adni a nevet, az e-mail címet és egy legalább 6 karakteres jelszót, opcionálisan fényképet. Ugyanitt, egy listában kipipálható, melyik feladatot lássa – az elmentéskor ez azonnal érvénybe lép.

A munkatárs ezután **a saját e-mail címével és jelszavával** lép be ugyanazon a webcímen. A tulajdonos továbbra is a `PeterKevin` / `peterkevin2026` párossal (vagy a saját, később beállított e-mail címével).

### Láthatóság beállítása egy feladatnál

Nyisd meg a feladatot: jobb oldalt (telefonon felül) a **Kinek látható** blokkban választható a *Mindenkinek* vagy a *Csak a kiválasztottaknak* mód. Korlátozott feladatnál a kártyán 🔒 jelenik meg – csak a tulajdonos látja ezt a jelet.

A feladathoz **hozzárendelt** személy mindig látja azt, akkor is, ha külön nincs kipipálva. Így nem fordulhat elő, hogy valakinek olyan feladata van, amit nem lát.

### Ez valódi védelem, nem csak elrejtés

A szűrés a szerveren történik: amit valaki nem láthat, az **el sem hagyja a szervert**, tehát a böngésző fejlesztői eszközeivel sem hozható elő. Ugyanez vonatkozik a jegyzetekre, mellékletekre, értesítésekre és az e-mailekre. A privát csevegéseket is csak a résztvevők kapják meg.

Mentéskor a szerver szintén ellenőriz: a munkatárs csak a számára látható feladatokat módosíthatja vagy törölheti, a többi érintetlen marad. Felhasználót, projektet vagy oszlopot a beküldött adatokkal sem tud létrehozni.

A jelszavak soha nem kerülnek ki a szerverről, csak a `"e-mail:jelszó"` SHA-256 lenyomata tárolódik.

### Amire figyelni kell

- **E-mail cím módosítása után a jelszót újra be kell állítani**, mert a belépés az e-mail és a jelszó együtteséből képződik.
- A mintaadatok között szereplő személyeket (Anna Berger, Kovács Péter, Lukas Wagner) nevezd át a saját csapatodra, vagy töröld őket. Az elsőként szereplő személy a tulajdonos – őt érdemes átnevezni magadra.
- Jelszó elfelejtése esetén a tulajdonos ad újat a **Csapat kezelése** ablakban. A tulajdonos saját jelszava a fájlban módosítható (lásd a 3. pontot).

---

## 4. Hogyan működik a szinkronizálás

- A teljes tábla egyetlen JSON-objektum, amit a függvény a Netlify Blobs tárolóba ment (`projektboard` store, `board` kulcs).
- Minden mentésnél nő egy verziószám (`rev`). A böngésző ezt küldi vissza: ha közben más is mentett, a szerver `409`-cel válaszol, a böngésző **összefésüli** a két állapotot, majd újra küld.
- Az összefésülés objektumonként történik: minden feladat, jegyzet, ellenőrzőlista-pont és üzenet saját azonosítót és módosítási időbélyeget kap. Ütközésnél a frissebb változat nyer, a törléseket „törlésjelölő" őrzi, hogy ne éledjenek fel újra. Így ha ketten egyszerre dolgoznak, egyik munkája sem vész el.
- Lekérdezés gyakorisága: **5 másodperc** aktív munka közben, **30 másodperc** tétlenségnél, háttérben lévő fülnél ritkábban. A `public/index.html`-ben állítható:

```js
const SYNC = {
  url:"/api/board",
  fast:5000,     // aktív használat közben
  slow:30000,    // tétlenség esetén
```

- Ha a szerver nem érhető el (nincs net, elfogyott a kvóta), az alkalmazás automatikusan helyi módba vált, minden tovább működik, és a kapcsolat helyreálltakor magától feltölti a változásokat.
- **Az első csatlakozáskor** az eszköz átveszi a szerveren lévő táblát a saját mintaadatai helyett. A tábla első tartalmát tehát az az eszköz adja, amelyik először lép be.

### Amit nem szinkronizál (szándékosan)

A nyelvbeállítás, a kiválasztott „bejelentkezve mint" személy és az elolvasott értesítések eszközönként egyediek.

**Kérd meg a csapattagokat, hogy belépés után jobb felül válasszák ki magukat** a listából. Ettől lesznek helyesek az értesítések („X módosította…"), a jegyzetek szerzői és a csevegés.

---

## 5. Kvóták és költség

A Netlify ingyenes csomagja korlátos (a 2025 szeptembere után nyitott fiókoknál kredit alapú, a régebbieknél havi 125 000 függvényhívás). Nagyságrendi becslés 5 másodperces lekérdezéssel: **egy aktívan dolgozó ember napi 8 órában kb. 5 700 hívás.**

Ajánlások:
- 3–5 fős csapatnál emeld a `fast` értéket 8–10 másodpercre – így is azonnalinak érződik, de töredékére csökken a hívások száma.
- A Netlify **Usage** oldalán követhető a fogyás.
- Ha kevés lenne: a Personal csomag havi 9 dollár, vagy a szinkronizálás átköthető egy ingyenes Supabase-projektre (WebSocket alapú, nincs hívásonkénti korlát) – ekkor csak a `SYNC` modul `pull` és `send` függvényét kell átírni.

---

## 6. E-mail értesítések (választható)

Ha be van állítva, a szerver e-mailt küld, amikor a táblán olyasmi történik, amire az illető feliratkozott – akkor is, ha éppen zárva van a böngészője.

### Beállítás a Netlify oldalán

1. Regisztrálj a **resend.com** oldalon (ingyenes csomag: kb. 3 000 levél havonta).
2. **API Keys → Create API Key** → másold ki a `re_…` kezdetű kulcsot.
3. Netlify → **Project configuration → Environment variables → Add a variable**:

```
RESEND_API_KEY = re_…
```

4. **Deploys → Trigger deploy → Deploy site** (környezeti változó csak új deploy után lép életbe).

Ha a `RESEND_API_KEY` nincs beállítva, a küldés egyszerűen kikapcsolt marad; az alkalmazás minden más funkciója változatlanul működik.

### Fontos korlát saját domain nélkül

A Resend alapértelmezett feladója (`onboarding@resend.dev`) **csak arra a címre tud küldeni, amellyel a Resend-fiók készült**. Ez elég, ha a tulajdonos akar értesítést kapni. Ha a csapat több tagjának is menjen levél:

1. Resend → **Domains → Add Domain**, majd a megadott DNS-rekordok (SPF, DKIM) felvétele a domain szolgáltatójánál.
2. Netlify környezeti változó:

```
MAIL_FROM = Projekt <projekt@sajatdomain.hu>
```

### Beállítás az alkalmazásban

Új munkatárs felvételekor a rendszer **automatikusan bekapcsolja** neki az értesítést a megadott e-mail címre. Mindenki finomíthatja is: jobb felül a profilkép → **E-mail értesítések** – megadható, kinek a módosításairól kér levelet, és hogy csak a neki kiosztott feladatokról.

A munkatárs **csak olyan feladatról kap levelet, amit láthat**; a tulajdonos mindenről.

### Próbaüzenet és hibakeresés

Az alkalmazásban a profilkép → **E-mail értesítések** ablakban a **Teszt e-mail küldése** gomb azonnal küld egy próbalevelet, és a mailszolgáltató válaszát szó szerint kiírja. Tipikus üzenetek:

| Üzenet | Jelentés |
|---|---|
| `RESEND_API_KEY ist bei Netlify nicht gesetzt` | Nincs kulcs, vagy a beállítás után nem volt új deploy. |
| `You can only send testing emails to your own email address…` | Saját domain nélkül csak a Resend-fiók címére lehet küldeni. |
| `Invalid API key` | Elgépelt vagy visszavont kulcs. |
| zöld visszajelzés, de nincs levél | Nézd meg a spam mappát és a Resend → **Logs** oldalt. |

### Működés

- A szerver minden mentésnél megnézi, van-e új esemény, amire valaki feliratkozott.
- **Címenként legfeljebb percenként egy levél**, összesítve (`MAIL_THROTTLE` a `board.mjs`-ben állítható). Egy levélben legfeljebb 12 sor szerepel.
- A saját műveletekről senki nem kap értesítést – teszthez másik személynek kell módosítania.
- A levél nyelve az illető alkalmazásban beállított nyelve.
- Új cím megadásakor a rendszer csak az azt követő eseményekről küld – korábbiakat nem pótol.

---

## 7. Korlátok, amikkel jó számolni

- **Mellékletek:** a fájlok base64 formában a tábla JSON-jában utaznak, ezért 3 MB fölötti fájlt az alkalmazás visszautasít. Sok nagy kép esetén a tábla lassan nő – ha ez zavaró lesz, a mellékleteket külön kell tárolni (Netlify Blobs, fájlonként külön kulccsal) és csak a hivatkozást menteni.
- **Csevegés:** ugyanazon a szinkronizáláson keresztül működik, az üzenet néhány másodperc késéssel érkezik. Nem chatszolgáltatás, hanem egyszerű üzenetváltás.
- **Egyidejűség:** a leírt összefésülés a gyakorlati eseteket kezeli. Ha ketten *ugyanazt a mezőt* módosítják két másodpercen belül, a később mentett érték marad.

### Adatmentés és -törlés

```bash
netlify blobs:get projektboard board > mentes.json     # biztonsági mentés
netlify blobs:delete projektboard board                # tábla nullázása
```

Törlés után a következő belépő eszköz mintaadatai kerülnek fel. A böngészőben tárolt helyi másolat a fejlesztői konzolban törölhető: `localStorage.clear()`.

---

## 8. Mobil használat

Az alkalmazás telefonon és táblagépen is teljes értékű – nincs külön mobilverzió, ugyanaz a cím nyílik meg.

- **Menü:** bal felül a ☰ gomb nyitja a feladatcsoportokat és a csapatot; a sáv melletti területre koppintva bezárul.
- **Keresés:** a nagyító ikonnal nyílik teljes szélességben.
- **Nyelvváltás:** telefonon a profilkép menüjében található (DE / HU).
- **Feladat áthelyezése:** koppintás megnyitja a feladatot, **nyomva tartás (kb. fél másodperc) után** lehet húzni. Így a lapozás és a görgetés ujjal továbbra is működik. A képernyő szélénél a tábla magától továbbgördül a következő oszlopra.
  Alternatíva: nyisd meg a feladatot, és fent a **Feladatmező** legördülőben válaszd ki az új oszlopot.
- **Feladat ablaka:** teljes képernyős; legfelül az állapot, határidő, prioritás, szín és a hozzárendelt tagok, alatta a leírás, ellenőrzőlista, mellékletek és jegyzetek.
- **Mellékletek:** a kijelölt területre koppintva a telefon felajánlja a kamerát és a fájlokat is.
- **Kezdőképernyőre tehető:** Safari → Megosztás → *Kezdőképernyőhöz adás*, Chrome → menü → *Alkalmazás telepítése*. Ezután saját ikonnal, böngészősáv nélkül indul.

A beviteli mezők betűmérete szándékosan 16 képpont, így az iPhone nem nagyít bele automatikusan.

---

## 9. Funkciók

- **Két nyelv:** német és magyar, fent jobbra váltható
- **Feladatcsoportok** (projektek) → **feladatmezők** (oszlopok) → **feladatok**
- **Húzd és ejtsd:** feladat áthelyezése egérrel, a tábla szélén automatikus gördüléssel
- **Feladat részletei:** leírás, ellenőrzőlista folyamatjelzővel, határidő, szín, prioritás, hozzárendelt tagok
- **Mellékletek:** dokumentumok és képek húzással, képeknél előnézettel
- **Jegyzetek:** hozzászólás, válasz, hangulatjel-reakciók
- **Értesítések:** minden változásnál rövid felugró üzenet, a csengő alatt a lista; kattintásra megnyílik az érintett feladat
- **Keresés:** feladatok, leírások, jegyzetek, ellenőrzőlista-pontok között
- **Csevegés:** privát vagy csoportos
- **Csapat:** munkatársak saját belépéssel, névvel, fényképpel és feladatonkénti láthatósággal

---

## 10. Hibakeresés

| Jelenség | Ok és megoldás |
|---|---|
| Szürke pont a fejlécben | A `/api/board` nem érhető el. Netlify → **Logs → Functions**; ellenőrizd, hogy a `board` függvény települt-e. |
| `401 unauthorized` | A `BOARD_KEY` és az `AUTH_HASH` nem egyezik, vagy a változó után nem volt új deploy. |
| `MissingBlobsEnvironmentError` | A függvény nem Netlify-környezetben fut. Helyben `netlify dev` paranccsal indítsd. |
| A változás nem jelenik meg | A másik fülön a lekérdezés 30 másodperc tétlenség után lelassul; kattints a lapra. |
| A munkatárs nem tud belépni | Nincs jelszava, vagy e-mail-módosítás után nem lett új jelszó. **Csapat kezelése** → ✎ → új jelszó. |
| Nem érkezik e-mail | Nincs `RESEND_API_KEY`, vagy nem volt új deploy; saját domain nélkül csak a Resend-fiók címére megy levél. A Resend **Logs** oldalán látszik minden kísérlet. |

---

## 11. Technikai adatok

| | |
|---|---|
| Frontend | HTML + CSS + vanilla JavaScript, egyetlen fájlban, keretrendszer nélkül |
| Backend | Netlify Function **vagy** Cloudflare Worker, közös `lib/core.mjs` |
| Függőség | `@netlify/blobs` (csak szerveroldalon) |
| Böngészők | Chrome, Edge, Safari, Firefox – aktuális verziók |
| Mobil | teljes értékű; lásd a 8. pontot |
| Külső szolgáltatás | nincs (nem tölt be CDN-t, betűtípust, követőkódot) |

**Alapértelmezett nyelv:** a kezdőadatoknál a `lang:"de"` sort írd át `lang:"hu"` értékre.

Az `index.html` szerver nélkül, önmagában is megnyitható – ilyenkor szinkronizálás nélkül, csak helyi tárolással működik. Ez teszteléshez hasznos.
