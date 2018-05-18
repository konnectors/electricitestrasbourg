const {
  BaseKonnector,
  requestFactory,
  signin,
  saveBills,
  log
} = require('cozy-konnector-libs')
const cheerio = require('cheerio')

const request = requestFactory({
  cheerio: true,
  json: false,
  jar: true
})

const baseUrl = 'https://www.interactive.electricite-strasbourg.net'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'finding contracts')
  const $contractPage = await request(`${baseUrl}/connect/habilitation`)

  log('info', 'scrapping contracts')
  const $contractLinks = $contractPage('a[id^=consulterContrat_]')
  const $firstContract = $contractLinks.first();
  // @ TODO: scrapp all contracts
  const contractNumber = $firstContract.text().replace(/\D/g, '')
  const contractPageUrl = $contractPage('form[name="theForm"]').attr('action')

  // with every request, we need to send an id that we increment (almost) every time
  let requestId = 0;

  // naivation is mostly done through POST requests
  await request(`${baseUrl}/connect/${contractPageUrl}`, {
    method: 'post',
    form: {
      act: 'consulterContrat',
      _rqId_: requestId++,
      _mnLck_: true,
      selIdcontrats: contractNumber
    }
  });

  log('info', `scrapping contract ${contractNumber}`)

  const $billsPage = await request(`${baseUrl}/connect/contrat.ZoomerContratOGeneralites.go`, {
    method: 'post',
    form: {
      act: 'afficherOnglet',
      _rqId_: requestId++,
      _ongIdx: '302001',
      _mnLck_: 'false',
      etat: 'actif'
    }
  })

  const bills = [];

  $billsPage('#tbl_mesFacturesExtrait tr').has(`a[onclick^="validerConnexion"]`).each((index, element) => {
    const $elem = cheerio.load(element);
    const onclick = $elem(`a[onclick^="validerConnexion"]`).last().attr('onclick');
    const billId = /(\d+)\'\)$/g.exec(onclick)[1];
    requestId = parseInt(/_rqId_=(\d)+/g.exec(onclick)[1]);

    const reference = $elem('td').eq(0).text();
    const date = new Date($elem('td').eq(1).text().split('/').reverse().join('/'));
    const amount = $elem('td').eq(3).text();

    bills.push({
      billId,
      reference,
      date,
      amount,
    })
  })

  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')

  for (let i = 0; i < bills.length; ++i) {
    const { billId, date, amount, reference } = bills[i];

    await request(`${baseUrl}/connect/contrat.ZoomerContratOFactures.go?act=consulterFactureDuplicata&selIdmesFacturesExtrait=${billId}&_rqId_=${requestId++}`)

    await saveBills([{
      date,
      amount,
      vendor: 'ES Strasbourg',
      currency: '€',
      filename: `${reference}.pdf`,
      fileurl: `https://www.interactive.electricite-strasbourg.net/connect/contrat.ZoomerContratOFactures.go`,
      requestOptions: {
        method: 'post',
        form: {
          act: 'afficherDocument',
          _rqId_: requestId,
          _mnLck_: false
        }
      },
    }], fields.folderPath, {
      identifiers: ['es energies strasbourg', 'es', 'strasbourg', 'energies']
    })
  }
}

function authenticate(username, password) {
  return signin({
    url: `https://www.interactive.electricite-strasbourg.net/aelfr/accescybercompte/AuthCybercompteProcess`,
    formSelector: '#formAppli',
    formData: {
      _codeaction: 'accueil',
      AuthProvider: 'AccesPro',
      Forward: '/aelfr/accescybercompte/AuthCybercompteProcess',
      _backUrl: null,
      Login: username,
      Motdepasse: password
    },
    // the validate function will check if
    validate: (statusCode, $) => {
      // The login in toscrape.com always works excepted when no password is set
      if ($(`meta[http-equiv="Refresh"]`).length === 1) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        log('error', $('#formLogin font[color="red"]').text())
        return false
      }
    }
  })
}
