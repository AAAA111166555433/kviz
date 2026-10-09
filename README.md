# DMSS kviz — v1.3.0

Kviz aplikacija za konferenciju **„RZS: Od podataka ka odlučivanju — DMSS u praksi”** (Zlatibor, 24–27. 11. 2026). Ima tri ekrana:

| Ekran | Adresa | Ko ga koristi |
|---|---|---|
| **Učesnici** | `http://<server>:3000/` | telefoni u sali (preko QR koda) |
| **Veliki ekran** | `http://<server>:3000/ekran` | projektor u sali |
| **Voditelj** | `http://<server>:3000/admin` | voditelj kviza (laptop/tablet) |

Aplikacija nema npm zavisnosti. Potreban je samo **Node.js 22.13 ili noviji** (preporuka: Node 24 LTS). Baza je SQLite fajl `data/kviz.db`, a pravi se sama pri prvom pokretanju.

---

## 1. Pokretanje

```bash
# 1) instalirati Node.js 22.13+ (https://nodejs.org) — na Windows-u običan instaler
# 2) u folderu aplikacije:
npm start
```

Server ispiše adrese, na primer:

```
DMSS kviz v1.3.0 radi na portu 3000
Učesnici:     http://10.1.2.15:3000/
Veliki ekran: http://localhost:3000/ekran
Voditelj:     http://localhost:3000/admin
```

Server se gasi sa `Ctrl+C`. Svi podaci ostaju u `data/kviz.db`, pa se posle ponovnog pokretanja nastavlja tamo gde se stalo, i ako je pitanje bilo u toku.

## 2. Podešavanja — `config.json`

| Polje | Značenje |
|---|---|
| `adminPassword` | **Obavezno promeniti.** Lozinka za ekran voditelja. |
| `port` | Port servera (podrazumevano 3000). |
| `publicUrl` | Adresa koja ide u QR kod, npr. `"http://10.1.2.15:3000/"` ili `"https://kviz.stat.gov.rs/"`. Ako ostane prazno, koristi se adresa računara u lokalnoj mreži. |
| `title`, `subtitle` | Naslov i podnaslov na ekranima. |
| `scheduleNote` | Tekst na početnom ekranu (kada se igra kviz). |
| `defaultTimeLimit` | Podrazumevano vreme za odgovor u sekundama (ako pitanje nema svoje). |
| `scoring.max` / `scoring.min` | Bodovi za tačan odgovor: odmah = `max`, na isteku vremena = `min` (1000 → 500). Netačan = 0. |
| `animalRankBy` | `"total"` = životinje se rangiraju po **ukupnom** broju tačnih odgovora; `"average"` = po **proseku po igraču** (pravednije ako životinje nemaju isti broj igrača). |
| `animals` | 10 životinja (id, naziv, emoji). Ne menjati `id` posle početka konferencije. |

Lozinka i port mogu da se zadaju i kroz promenljive okruženja `ADMIN_PASSWORD` i `PORT`.

## 3. Pitanja

Pitanja se unose na dva načina:

* **u ekranu voditelja**, kartica *Pitanja*: dodavanje, izmena, redosled, brisanje, nove sesije;
* **uvozom JSON fajla**, u istom formatu kao `questions.json`:

```json
{
  "sessions": [
    {
      "name": "Dan 2: Područna odeljenja, društvene statistike i registri",
      "questions": [
        { "text": "Tekst pitanja?", "options": ["A odgovor", "B odgovor", "C odgovor", "D odgovor"], "correct": "B", "timeLimit": 20 }
      ]
    }
  ]
}
```

* 2–4 ponuđena odgovora, `correct` je slovo tačnog odgovora, `timeLimit` (5–120 s) nije obavezan.
* `questions.json` se učitava automatski samo pri **prvom** pokretanju, dok je baza prazna. Pitanja u njemu su **primeri** i treba ih zameniti.
* Uvoz zamenjuje sva pitanja i briše sve odgovore. Zato pitanja treba uvesti **pre** konferencije.
* Ako se tačan odgovor ispravi posle igranja, bodovi za to pitanje se automatski preračunavaju.

## 4. Raspored na konferenciji (po nacrtu agende)

Kviz je **kratak, oko 10 minuta**, u okviru polusatnih termina iz agende. Svaki dan ima jednu sesiju od **8 pitanja**, a teme pitanja prate izlaganja tog dana.

| Kada | Termin u agendi | Sesija u aplikaciji | Teme pitanja |
|---|---|---|---|
| **Dan 1**, utorak 24. 11. | registracija 14.00, piće dobrodošlice 17.10 | — | veliki ekran na **početnom ekranu sa QR kodom**, da se učesnici prijave unapred |
| **Dan 2**, sreda 25. 11. | **17.30–18.00** (tačka 18) | Dan 2: Područna odeljenja, društvene statistike i registri | terensko prikupljanje (CAPI), put podatka (GSBPM), popis i popisni krug, vitalni događaji, tržište rada, ciljevi održivog razvoja, administrativni izvori |
| **Dan 3**, četvrtak 26. 11. | **17.00–17.30** (tačka 32) | Dan 3: Poslovne statistike i nacionalni računi | Statistički poslovni registar, STS, IKT, turizam, saobraćaj, energetika, poljoprivreda, BDP |
| **Dan 4**, petak 27. 11. | — | — | po želji: ukupna rang-lista i *statistička priča* pre zaključaka (13.20) |

Pitanja u `questions.json` su **predlog** i treba da ih provere autori iz sektora. Uz svako pitanje je polje `_tema` sa tačkom agende na koju se odnosi; aplikacija ga ne prikazuje.

**Satnica 10 minuta:**

| Minut | Šta | Dugme kod voditelja |
|---|---|---|
| 0–1 | otvaranje, prijava onih koji kasne | *Otvori sesiju* |
| 1–8 | 8 pitanja: 15–20 s za odgovor i oko 30 s za rešenje sa kratkim komentarom | *▶ Sledeće pitanje* → *✓ Prikaži rešenje* |
| 8–9 | rang-lista dana (podijum) | *🏆 Rang-lista* |
| 9–10 | takmičenje životinja; dan 3: ukupni rezultati cele konferencije | *🦁 Životinje*, a dan 3 i red „ukupno” |

Ako ostane vremena, prikazati i *📊 Statistika*. Ako je vreme tesno, rešenja komentarisati jednom rečenicom.

## 5. Kako učesnik učestvuje

1. Skenira QR kod sa velikog ekrana.
2. Izabere jednu od 10 životinja, upiše nadimak (2–20 znakova) i smisli **PIN od 4 cifre**.
3. Kombinacija *životinja + nadimak* je jedinstvena. Sistem proverava zauzetost dok učesnik kuca i ne razlikuje velika i mala slova ni č/c, š/s, đ/dj.
4. Telefon pamti prijavu. U narednim sesijama dovoljno je otvoriti stranicu, PIN se ne kuca ponovo.
5. PIN je potreban samo pri prijavi sa drugog telefona, u drugom browseru ili posle odjave: *Već imam nalog* → životinja + nadimak + PIN. Tako niko ne može da uđe kao neko drugi.
6. Posle 5 pogrešnih PIN-ova nalog se zaključava na 1 minut.

Ako učesnik zaboravi PIN, voditelj mu u kartici *Učesnici* postavlja novi.

## 6. Tok sesije (voditelj)

Ekran voditelja predlaže sledeći korak (dugme sa žutim okvirom).

1. **Otvori sesiju**: veliki ekran prikazuje naziv sesije i QR kod.
2. **▶ Sledeće pitanje**: pitanje ide na veliki ekran i na sve telefone, a tajmer počinje.
3. Pitanje se **zatvara samo** kad istekne vreme. Može i ranije, dugmetom *Zatvori pitanje*.
4. **✓ Prikaži rešenje**: raspodela odgovora i tačan odgovor; svaki telefon prikaže svoj rezultat i bodove.
5. Ponoviti 2–4 za sva pitanja.
6. **🏆 Rang-lista** sesije, zatim **🦁 Životinje** i po želji **📊 Statistika**.
7. **Završi sesiju**: veliki ekran se vraća na početni sa QR kodom.

Na kraju konferencije koristite dugmad iz reda **„ukupno (sve sesije)”**: ukupna rang-lista, takmičenje životinja i *statistička priča* (broj učesnika i odgovora, procenat tačnih, najteže i najlakše pitanje, najbrži tačan odgovor, najpopularnija životinja).

Bilo koje pitanje može da se pokrene i direktno, dugmetom ▶ pored njega. Ako na pitanje već postoje odgovori, aplikacija pita da li da ih obriše i pokrene pitanje ponovo.

**Bodovanje:** tačan odgovor donosi 500–1000 bodova, više što je brži. Nerešeno se razrešava brojem tačnih odgovora, pa ukupnim vremenom tačnih odgovora.

## 7. Podaci i izvoz

Kartica *Statistika*:

* **Odgovori (CSV)**: svaki odgovor sa sesijom, pitanjem, životinjom, nadimkom, tačnošću, bodovima i vremenom u ms. Pogodno za analizu posle konferencije.
* **Ukupna rang-lista (CSV)**.

CSV fajlovi koriste `;` kao separator i UTF-8 sa BOM-om, pa se u Excel-u otvaraju direktno.

Kartica *Podaci* briše odgovore, ili odgovore i učesnike, posle probe. Za potvrdu se upisuje `OBRIŠI`.

Rezervna kopija: dovoljno je kopirati folder `data/` dok je server ugašen.

## 8. Mreža — VAŽNO pre konferencije

Konferencija je u **hotelu na Zlatiboru**, ne u Zavodu, pa mreža u sali nije pod našom kontrolom. Telefoni moraju da „vide” server. Postoje dve mogućnosti:

* **Javno dostupan server** (server Zavoda ili iznajmljeni) preko HTTPS-a: **preporuka za Zlatibor**. Radi i preko hotelskog Wi-Fi-ja i preko mobilnih podataka, bez obzira na podešavanja hotelske mreže. U `publicUrl` upisati tu adresu.
* **Laptop u sali**: rezervna varijanta. Radi samo ako su laptop i telefoni na istoj mreži **i** ako Wi-Fi ne izoluje uređaje jedne od drugih (*client isolation* je čest na mrežama za goste). Na Windows-u treba dozvoliti port 3000 u Firewall-u.

Za 300 učesnika server nije usko grlo. Na testu sa 300 simuliranih telefona odgovori su obrađeni za nekoliko milisekundi. Usko grlo je **Wi-Fi u sali**, pa je dobro da IT proveri kapacitet pristupnih tačaka. Učesnici mogu da koriste i mobilne podatke ako je server javno dostupan.

Ako aplikacija ide iza nginx-a ili IIS-a kao reverse proxy, za `/api/stream` treba isključiti baferovanje (Server-Sent Events). Aplikacija za nginx već šalje zaglavlje `X-Accel-Buffering: no`.

## 9. Test opterećenja

```bash
node test/load-test.js 300 http://localhost:3000 <admin-lozinka>
```

Simulira 300 učesnika: istovremenu registraciju, 300 otvorenih veza, odgovaranje na pitanje i prikaz rezultata, uz proveru grešaka i bodova. **Briše sve odgovore i učesnike**, pa ga pokretati samo pre konferencije.

## 10. Kontrolna lista

- [ ] Promenjena `adminPassword`; autori proverili predložena pitanja; proverena `publicUrl`
- [ ] Sa hotelom proveriti: Wi-Fi za ~300 telefona u sali, da li gosti mogu da pristupe serveru, projektor/HDMI za veliki ekran
- [ ] Dan 1: veliki ekran na početnom ekranu (QR) tokom registracije i pića dobrodošlice
- [ ] Generalna proba sa nekoliko telefona preko **Wi-Fi-ja u sali**
- [ ] Posle probe: *Podaci → Obriši odgovore i učesnike*
- [ ] Veliki ekran: otvoriti `/ekran` u browseru i uključiti *Ceo ekran* (dugme se pojavi kad se miš pomeri)
- [ ] Voditelj ima `/admin` na posebnom uređaju; pregled velikog ekrana je u ekranu voditelja
- [ ] Posle svakog dana: izvoz *Odgovori (CSV)* i kopija foldera `data/`

## Struktura

```
server.js            server (HTTP, SSE, SQLite, bodovanje)
config.json          podešavanja
questions.json       predlog pitanja po temama agende (početno punjenje)
public/index.html    ekran učesnika (telefon)
public/screen.html   veliki ekran
public/admin.html    ekran voditelja
public/common.js     zajedničke funkcije
public/style.css     zajednički stilovi (+ lokalni font)
public/fx.css        tamna „scenska” tema (veliki ekran i telefoni)
public/fx.js         efekti: konfete, animirano brojanje, tajmer
public/vendor/       QR generator (qrcode-generator, MIT) i font Plus Jakarta Sans (OFL)
test/load-test.js    test opterećenja
data/                baza (pravi se automatski)
```

## Izmene

**v1.3.0**: kratak kviz od 10 minuta.
- Jedna sesija od 8 pitanja po danu umesto više rundi.
- Predlog pitanja po temama izlaganja iz agende: dan 2 područna odeljenja, društvene statistike i registri; dan 3 poslovne statistike, poljoprivreda i nacionalni računi.
- Vreme za odgovor 15–20 s; uputstvo ima satnicu od 10 minuta.

**v1.2.0**: usklađeno sa nacrtom agende (Zlatibor, 24–27. 11. 2026).
- Runde po agendi: dan 2 (17.30) tri runde, dan 3 (17.00) dve runde.
- Podnaslov i tekst na početnom ekranu prema mestu i terminima kviza (novo polje `scheduleNote`).
- Uputstvo dopunjeno rasporedom, satnicom termina od 30 minuta i napomenama o hotelskoj mreži.

**v1.1.0**: nov, moderniji dizajn velikog ekrana i telefona.
- Tamna tema sa animiranom „aurora” pozadinom i staklenim karticama. Font je uključen u paket, pa radi i bez interneta.
- Početni ekran: QR kod u animiranom okviru, brojač prijavljenih uživo i niz poslednjih prijavljenih igrača.
- Pitanje: odgovori u gradijentima, traka odgovora uživo i kružni tajmer koji u poslednjih 5 s pulsira crveno.
- Rešenje: tačan odgovor se ističe, a raspodela se iscrtava animirano, uz konfete.
- Rang-lista kao podijum za prva tri mesta (zlato, srebro, bronza, kruna) i lista od 4. do 10. mesta.
- Takmičenje životinja kao trka traka, sa krunom za lidera.
- Statistika u mozaiku kartica sa animiranim brojevima.
- Telefon: nova prijava, animirani avatar dok čeka, konfete i vibracija za tačan odgovor, „protresanje” za netačan.

**v1.0.0**: prva verzija.
